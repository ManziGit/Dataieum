import asyncio
from contextlib import ExitStack,closing
import sqlite3
import sys
import tempfile
import threading
import time
from pathlib import Path
import unittest
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from discovery_harness.hybrid_search import fuse,keywords
from discovery_harness.response_cache import ResponseCache
from discovery_harness.capacity import ServerOverloaded
from refresh_http import ProviderHTTP


class Retrieval(unittest.TestCase):
    def test_rrf_combines_bounded_lists_without_duplicate_or_invented_similarity(self):
        rows=[{'dataset_id':str(n),'cosine':.9-n*.001} for n in range(140)]
        result=fuse(rows,['20','20','139'])
        self.assertEqual(result[0]['dataset_id'],'20')
        self.assertEqual(len(result),101)
        self.assertEqual(len({r['dataset_id'] for r in result}),101)
        self.assertEqual(next(r for r in result if r['dataset_id']=='139')['retrieval_ranks']['vector'],None)
        self.assertEqual(next(r for r in result if r['dataset_id']=='20')['cosine'],rows[20]['cosine'])

    def test_keyword_retrieval_keeps_source_coverage_mask_and_literal_query(self):
        with tempfile.TemporaryDirectory() as tmp:
            index=Path(tmp)/'search';mapping=Path(tmp)/'mapping'
            with closing(sqlite3.connect(index)) as db, db:
                db.executescript("CREATE TABLE documents(n INTEGER PRIMARY KEY,id TEXT);CREATE VIRTUAL TABLE phrases USING fts5(text,tokenize='trigram');")
                db.executemany('INSERT INTO documents VALUES(?,?)',[(1,'a'),(2,'b'),(3,'c')]);db.executemany('INSERT INTO phrases(rowid,text) VALUES(?,?)',[(1,'population'),(2,'population'),(3,'weather')])
            with closing(sqlite3.connect(mapping)) as db, db:
                db.executescript('CREATE TABLE records(label INTEGER PRIMARY KEY,dataset_id TEXT NOT NULL);CREATE INDEX records_dataset_id ON records(dataset_id);INSERT INTO records VALUES(0,"a"),(1,"b"),(2,"c");')
            labels,ids,state=keywords(index,mapping,'population',[False,True,True],time.monotonic()+2)
            self.assertEqual((labels,ids,state),([1],['b'],'ready'))
            self.assertEqual(keywords(index,mapping,'population OR weather',None,time.monotonic()+2)[1],[])


class ProviderLimits(unittest.TestCase):
    def test_slow_site_backs_off_and_recovers_only_after_stable_success(self):
        with tempfile.TemporaryDirectory() as tmp:
            client=ProviderHTTP(tmp,{'parallel_requests':1,'timeout_seconds':30})
            try:
                client.feedback(1,failed=True);self.assertEqual(client.penalty,2)
                for _ in range(7):client.feedback(.1)
                self.assertEqual(client.penalty,2)
                client.feedback(.1);self.assertEqual(client.penalty,1.6)
                for _ in range(100):client.feedback(.1)
                self.assertEqual(client.penalty,1)
            finally:client.close()

    def test_global_slots_are_shared_and_release_after_failure(self):
        with tempfile.TemporaryDirectory() as tmp:
            clients=[ProviderHTTP(Path(tmp)/str(n),{'parallel_requests':1},global_slots=Path(tmp)/'slots') for n in range(2)]
            ready=threading.Event();finished=threading.Event()
            def next_request():
                ready.set()
                with clients[1].slot():finished.set()
            try:
                with patch('refresh_http.os.getloadavg',return_value=(0,0,0)),patch('refresh_http.Path.read_text',return_value='MemAvailable: 9000000 kB\n'):
                    with ExitStack() as stack:
                        for _ in range(6):stack.enter_context(clients[0].slot())
                        thread=threading.Thread(target=next_request);thread.start();ready.wait(1)
                        self.assertFalse(finished.wait(.15))
                    thread.join(2);self.assertTrue(finished.is_set())
                    with self.assertRaises(ValueError):
                        with clients[0].slot():raise ValueError('cancelled')
                    with clients[1].slot():pass
            finally:
                for client in clients:client.close()


class Cancellation(unittest.IsolatedAsyncioTestCase):
    async def test_repeated_cancellation_does_not_release_a_cleaning_worker(self):
        cache=ResponseCache(max_flights=1);started=asyncio.Event();cleaning=asyncio.Event();finish=asyncio.Event()
        async def compute():
            started.set()
            try:await asyncio.Event().wait()
            finally:cleaning.set();await finish.wait()
        waiter=asyncio.create_task(cache.get('a',compute));await started.wait();waiter.cancel();await cleaning.wait();waiter.cancel();await asyncio.sleep(0)
        with self.assertRaises(ServerOverloaded):await cache.get('b',compute)
        finish.set()
        with self.assertRaises(asyncio.CancelledError):await waiter
        self.assertEqual(cache.status()['inflight'],0)


if __name__=='__main__':unittest.main()

class PreparationCache(unittest.TestCase):
    def test_exact_publication_only_and_corruption_falls_back(self):
        from types import SimpleNamespace
        from discovery_harness.native_catalog import NativeCatalog
        with tempfile.TemporaryDirectory() as tmp:
            native=object.__new__(NativeCatalog);native.overview=Path(tmp)/'overview.json';native._keyword_excluded='["hidden"]'
            value={'summary':{'year_counts':{'2026':15}}};native.module=SimpleNamespace(base_catalog=lambda:value);native.identity=lambda:('first',)
            native._save_preparation(native.identity());native._keyword_excluded=None;value['summary']['year_counts']={}
            self.assertTrue(native._restore_preparation(('first',)));self.assertEqual(value['summary']['year_counts'],{'2026':15})
            self.assertEqual(native._keyword_excluded,'["hidden"]');self.assertFalse(native._restore_preparation(('second',)))
            native.overview.with_suffix('.inputs.json').write_text('{')
            self.assertFalse(native._restore_preparation(('first',)))
