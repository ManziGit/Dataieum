import asyncio
from contextlib import contextmanager
import json
import sqlite3
from types import SimpleNamespace
import unittest

import httpx

from discovery_harness import catalog_pages
from discovery_harness.capacity import ServerOverloaded
from discovery_harness.http_api import create_read_api
from discovery_harness.response_cache import ResponseCache


class Pages(unittest.TestCase):
    def setUp(self):
        self.db=sqlite3.connect(':memory:');self.db.row_factory=sqlite3.Row
        self.db.executescript('''ATTACH DATABASE ':memory:' AS keyword;
          CREATE TABLE records(id TEXT PRIMARY KEY,source TEXT);
          CREATE TABLE keyword.documents(n INTEGER PRIMARY KEY,id TEXT UNIQUE);
          CREATE VIRTUAL TABLE keyword.terms USING fts5(text);
          CREATE VIRTUAL TABLE keyword.phrases USING fts5(text,tokenize='trigram');''')
        for n in range(1,86):
            self.db.execute('INSERT INTO keyword.documents VALUES(?,?)',(n,f'd-{n:03}'))
            self.db.execute('INSERT INTO keyword.terms(rowid,text) VALUES(?,?)',(n,'population' if n%2 else 'weather'))
            self.db.execute('INSERT INTO keyword.phrases(rowid,text) VALUES(?,?)',(n,'population' if n%2 else 'weather'))
            if n!=41:self.db.execute('INSERT INTO records VALUES(?,?)',(f'd-{n:03}','kr' if n%3 else 'us'))
        @contextmanager
        def connection():yield self.db
        def where(query):
            return (' WHERE r.source=?',[query['source']]) if query.get('source') else ('',[])
        def records(db,ids):return [{'id':i,'source_id':'kr','title':i,'description':'A'*900,'mappings':[]} for i in ids]
        self.native=SimpleNamespace(identity=lambda:('test-publication',),query=lambda q:q,connection=connection,
          module=SimpleNamespace(where=where,records=records,base_catalog=lambda:{'total':84}))

    def tearDown(self):self.db.close()

    def test_every_visible_record_exactly_once_and_separate_count(self):
        query={};ids=[]
        while True:
            page=catalog_pages.page(self.native,query);ids.extend(d['id'] for d in page['datasets'])
            self.assertTrue(all(len(d['description'])<=320 for d in page['datasets']))
            if not page['has_more']:break
            query['cursor']=page['next_cursor']
        self.assertEqual(ids,[f'd-{n:03}' for n in range(1,86) if n!=41])
        self.assertEqual(catalog_pages.count(self.native,{})['total'],len(ids))

    def test_keyword_and_source_filters_have_identical_page_count_membership(self):
        query={'q':'population','source':'kr'};ids=[]
        while True:
            page=catalog_pages.page(self.native,query);ids.extend(d['id'] for d in page['datasets'])
            if not page['has_more']:break
            query['cursor']=page['next_cursor']
        expected=[f'd-{n:03}' for n in range(1,86) if n%2 and n%3 and n!=41]
        self.assertEqual(ids,expected)
        self.assertEqual(catalog_pages.count(self.native,{'q':'population','source':'kr'})['total'],len(expected))

    def test_cursor_rejects_filter_and_publication_changes(self):
        first=catalog_pages.page(self.native,{})
        with self.assertRaises(ValueError):catalog_pages.page(self.native,{'cursor':first['next_cursor'],'source':'us'})
        self.native.identity=lambda:('new-publication',)
        with self.assertRaises(catalog_pages.StaleCursor):catalog_pages.page(self.native,{'cursor':first['next_cursor']})

    def test_keyword_first_page_never_sorts_all_matching_rows(self):
        seen=[]
        self.db.set_trace_callback(seen.append)
        catalog_pages.page(self.native,{'q':'population'})
        sql=next(s for s in seen if s.startswith('SELECT d.n,d.id'))
        plan=[r[3] for r in self.db.execute('EXPLAIN QUERY PLAN '+sql)]
        self.assertFalse(any('TEMP B-TREE' in detail for detail in plan),plan)


class Display(unittest.TestCase):
    def test_markup_is_displayed_as_text_without_changing_plain_comparisons(self):
        from discovery_harness.display_text import display_text
        self.assertEqual(display_text('<p>A &amp; B</p><p>2026<br>서울</p><script>bad()</script>'),'A & B 2026 서울')
        self.assertEqual(display_text('1 < 2 and 4 > 3'),'1 < 2 and 4 > 3')


class SharedWork(unittest.IsolatedAsyncioTestCase):
    async def test_cancel_one_waiter_preserves_the_other_and_computes_once(self):
        cache=ResponseCache();ready=asyncio.Event();finish=asyncio.Event();calls=0
        async def compute():
            nonlocal calls
            calls+=1;ready.set();await finish.wait();return b'answer'
        first=asyncio.create_task(cache.get('same',compute));await ready.wait()
        second=asyncio.create_task(cache.get('same',compute));await asyncio.sleep(0)
        first.cancel()
        with self.assertRaises(asyncio.CancelledError):await first
        finish.set();self.assertEqual(await second,b'answer')
        self.assertEqual(await cache.get('same',compute),b'answer');self.assertEqual(calls,1)
        self.assertEqual(cache.status()['inflight'],0)

    async def test_cancel_last_waiter_keeps_slot_until_cleanup_finishes(self):
        cache=ResponseCache(max_flights=1);ready=asyncio.Event();cleaning=asyncio.Event();finish=asyncio.Event()
        async def compute():
            ready.set()
            try:await asyncio.Event().wait()
            finally:cleaning.set();await finish.wait()
        first=asyncio.create_task(cache.get('same',compute));await ready.wait();first.cancel();await cleaning.wait()
        with self.assertRaises(ServerOverloaded):await cache.get('other',compute)
        with self.assertRaises(ServerOverloaded):await cache.get('same',compute)
        finish.set()
        with self.assertRaises(asyncio.CancelledError):await first
        self.assertEqual(cache.status()['inflight'],0)

    async def test_failed_work_is_not_cached_and_byte_budget_is_enforced(self):
        cache=ResponseCache(max_bytes=7)
        async def fail():raise ValueError('failed')
        with self.assertRaises(ValueError):await cache.get('failure',fail)
        self.assertEqual(cache.status()['entries'],0)
        for key in ['a','b','c']:
            async def compute():return b'1234'
            await cache.get(key,compute)
        self.assertLessEqual(cache.bytes,7);self.assertEqual(len(cache.entries),1)


class HTTPContracts(unittest.IsolatedAsyncioTestCase):
    async def test_invalid_filters_are_rejected_before_database_work(self):
        backend=SimpleNamespace()
        app=create_read_api(backend)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://localhost') as client:
            for path in ['/api/catalog/page?year=bad','/api/catalog/page?unknown=1','/api/catalog/page?cursor=!!!','/api/catalog/count?band=wrong','/api/catalog?page=-1']:
                with self.subTest(path=path):self.assertEqual((await client.get(path)).status_code,400)


if __name__=='__main__':unittest.main()
