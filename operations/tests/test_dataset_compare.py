from collections import Counter
from contextlib import closing
import json
from pathlib import Path
import sqlite3
from types import SimpleNamespace
import unittest
from urllib.parse import urlencode

from discovery_harness.dataset_compare import snapshot,validate_query,safe_url
from discovery_harness.dataieum import DataieumApp


class Comparison(unittest.TestCase):
    def setUp(self):
        self.db=sqlite3.connect(':memory:');self.db.row_factory=sqlite3.Row
        self.db.executescript('CREATE TABLE datasets(id TEXT PRIMARY KEY,source_id TEXT,title TEXT,description TEXT,metadata TEXT,checked_at TEXT);CREATE TABLE sources(id TEXT PRIMARY KEY,info TEXT);')
        self.db.execute('INSERT INTO sources VALUES(?,?)',('a',json.dumps({'name':'Official portal','country':'Do not infer this country'})))
        self.add('a:1',{'publisher':'Provider','period':'1990–2000','source_modified':'2026-03-01','license':'https://example.org/licence','url':'https://example.org/dataset'})
        self.add('a:2',{'region':'미상','period':'미상','format':'제공처 확인','license':'제공처 확인','url':'javascript:alert(1)'})
        self.db.commit()

    def tearDown(self):self.db.close()

    def add(self,ident,metadata):
        self.db.execute('INSERT INTO datasets VALUES(?,?,?,?,?,?)',(ident,'a','2024 title <script>','Description',json.dumps(metadata),'2026-09-27T00:00:00Z'))

    def read(self,ids):return snapshot(self.db,{'ids':json.dumps(ids)})

    def test_order_missing_record_and_read_only_indexed_lookup(self):
        self.db.execute('PRAGMA query_only=ON');before=self.db.total_changes
        value=self.read(['a:2','not-present','a:1'])['items']
        self.assertEqual([r['id'] for r in value],['a:2','not-present','a:1'])
        self.assertFalse(value[1]['found']);self.assertEqual(self.db.total_changes,before)
        plan=' '.join(row[3] for row in self.db.execute('EXPLAIN QUERY PLAN SELECT * FROM datasets WHERE id IN (?,?)',('a:1','a:2')))
        self.assertIn('INDEX',plan);self.assertNotIn('SCAN datasets',plan)

    def test_unknown_values_and_dates_are_not_inferred(self):
        a,b=self.read(['a:1','a:2'])['items']
        self.assertEqual(a['values']['period'],'1990–2000')
        self.assertEqual(a['values']['source_modified'],'2026-03-01')
        self.assertEqual(a['values']['checked_at'],'2026-09-27T00:00:00Z')
        self.assertEqual(a['source'],'Official portal')
        self.assertIsNone(a['values']['region'])
        for k in ['region','period','source_modified','format','license']:self.assertIsNone(b['values'][k])
        self.assertIsNone(b['url']);self.assertEqual(a['license_url'],'https://example.org/licence')

    def test_existing_long_ids_and_unicode_are_supported(self):
        ids=['eu:'+('x'*1680)+str(i) for i in range(4)]
        for ident in ids:self.add(ident,{'publisher':'서울 · München · 日本'})
        result=self.read(ids);self.assertEqual(len(result['items']),4)
        self.assertEqual(result['items'][0]['values']['publisher'],'서울 · München · 日本')

    def test_selection_bounds_and_sql_values(self):
        for ids in [[],['a:1'],['a:1']*2,['x']*5,['a:1',1],['a:1','bad\x00id'],['a:1','x'*2049],{'id':'a:1'}]:
            with self.subTest(ids=str(ids)[:60]),self.assertRaises(ValueError):self.read(ids)
        self.assertFalse(self.read(['a:1',"' OR 1=1 --"])['items'][1]['found'])
        for query in [{},{'ids':'not json'},{'ids':json.dumps(['a:1','a:2']),'q':'x'}]:
            with self.assertRaises(ValueError):validate_query(query)

    def test_bad_metadata_is_explicit_and_response_is_bounded(self):
        self.db.execute('UPDATE datasets SET metadata=? WHERE id=?',('x'*1048577,'a:1'))
        result=self.read(['a:1','a:2']);self.assertFalse(result['items'][0]['metadata_available'])
        self.assertLess(len(json.dumps(result)),10000)
        self.db.execute('UPDATE datasets SET metadata=? WHERE id=?',(json.dumps({'license':'a'*100000}),'a:1'))
        self.assertTrue(self.read(['a:1','a:2'])['items'][0]['values']['license'].endswith('…'))

    def test_links_do_not_allow_script_or_credentials(self):
        for link in ['javascript:alert(1)','data:text/html,x','https://user:pass@example.org','//example.org','https://example.org:bad','https://example.org/\nsecret','http://[bad']:
            with self.subTest(link=link):self.assertIsNone(safe_url(link))
        self.assertEqual(safe_url('https://example.org/a?b=1&c=2'),'https://example.org/a?b=1&c=2')


class ComparisonRoute(unittest.IsolatedAsyncioTestCase):
    async def handle(self,query,host='localhost'):
        import httpx
        from discovery_harness.http_api import create_read_api
        app=DataieumApp.__new__(DataieumApp);app._status_counts=Counter();app.ready=True;app.worker=SimpleNamespace(alive=True)
        app._cached_sends=0;app._cache_key=lambda *a:'test-version'
        admitted=[]
        async def run(fn):return await fn(SimpleNamespace())
        async def database(session,operation,query):admitted.append(query);return {'items':[]}
        app._database_query=database
        app.harness=SimpleNamespace(healthy=True,run=run,capacity=SimpleNamespace(check_response=lambda:None),policy=SimpleNamespace(server=SimpleNamespace(max_response_bytes=1048576)))
        app._http=create_read_api(app)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app._handle),base_url='http://'+host) as client:
            response=await client.get('/api/compare?'+query.decode())
        return admitted,response

    async def test_duplicate_query_fields_fail_before_worker(self):
        encoded=urlencode({'ids':json.dumps(['a:1','a:2'])}).encode()
        admitted,response=await self.handle(encoded+b'&'+encoded)
        self.assertEqual(admitted,[]);self.assertEqual(response.status_code,400)

    async def test_long_selection_uses_existing_bounded_worker_path(self):
        ids=['eu:'+('x'*1680)+str(i) for i in range(4)]
        admitted,response=await self.handle(urlencode({'ids':json.dumps(ids)}).encode())
        self.assertEqual(json.loads(admitted[0]['ids']),ids);self.assertEqual(response.status_code,200)
        self.assertIn('no-store',response.headers['cache-control'])

    async def test_local_host_boundary_is_preserved(self):
        admitted,response=await self.handle(urlencode({'ids':json.dumps(['a:1','a:2'])}).encode(),'untrusted.example')
        self.assertEqual(admitted,[]);self.assertEqual(response.status_code,403)


if __name__=='__main__':unittest.main()
