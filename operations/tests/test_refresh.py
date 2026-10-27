import asyncio
from contextlib import closing
from datetime import datetime,timezone
import hashlib
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

sys.path[:0]=[str(Path(__file__).resolve().parents[1]),str(Path(__file__).resolve().parents[2])]
import embedding_batch as eb
from refresh_state import (connect,configure,claim_rotation,finish_rotation,reserve_batch,settle_batch,
                           budget_used,day,DailyBudgetReached,content_hash)
from refresh_http import next_pages,ProviderHTTP
from refresh_batch import BudgetAPI,tick,discard_obsolete_unsubmitted
from refresh_collect import Collector


def instant(d):return datetime(2026,10,d,4,tzinfo=timezone.utc)


class Ledger(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name);self.db=connect(self.root)
        self.sources=[f'site{i:02d}' for i in range(40)];configure(self.db,self.sources)
    def tearDown(self):self.db.close();self.temp.cleanup()
    def complete(self,ident):
        with self.db:self.db.execute("UPDATE source_runs SET status='complete' WHERE rotation=?",(ident,))
    def grant(self):
        from refresh_quality import save_result,result
        with self.db:
            for row in self.db.execute('SELECT * FROM changes').fetchall():
                save_result(self.db,row,result('verified','fixture'))
    def batch(self,tokens):
        with self.db:return self.db.execute("INSERT INTO batches(marker,status,tokens,count) VALUES(lower(hex(randomblob(16))),'prepared',?,1)",(tokens,)).lastrowid

    def test_five_days_cover_all_40_and_next_day_wraps(self):
        visited=[]
        for d in range(1,6):
            ident,sites=claim_rotation(self.db,instant(d));visited+=sites
            self.complete(ident);self.assertTrue(finish_rotation(self.db,ident,instant(d)))
            self.assertIsNone(claim_rotation(self.db,instant(d)))
        self.assertEqual(visited,self.sources)
        self.assertEqual(claim_rotation(self.db,instant(6))[1],self.sources[:8])

    def test_restart_resumes_unfinished_group_and_does_not_start_another_today(self):
        ident,sites=claim_rotation(self.db,instant(1))
        with self.db:self.db.execute("UPDATE source_runs SET status='complete' WHERE rotation=? AND source=?",(ident,sites[0]))
        self.db.close();self.db=connect(self.root)
        self.assertEqual(claim_rotation(self.db,instant(4)),(ident,sites))
        self.assertFalse(finish_rotation(self.db,ident,instant(4)))
        self.complete(ident);finish_rotation(self.db,ident,instant(4))
        self.assertIsNone(claim_rotation(self.db,instant(4)))
        self.assertEqual(claim_rotation(self.db,instant(5))[1],self.sources[8:16])

    def test_failure_does_not_stall_rotation_and_is_not_called_complete(self):
        ident,sites=claim_rotation(self.db,instant(1));self.complete(ident)
        with self.db:self.db.execute("UPDATE source_runs SET status='failed' WHERE rotation=? AND source=?",(ident,sites[0]))
        self.assertTrue(finish_rotation(self.db,ident,instant(1)))
        self.assertEqual(self.db.execute('SELECT status FROM source_runs WHERE source=?',(sites[0],)).fetchone()[0],'failed')
        self.assertEqual(self.db.execute('SELECT status FROM rotations WHERE id=?',(ident,)).fetchone()[0],'attempted')
        self.assertEqual(claim_rotation(self.db,instant(2))[1],self.sources[8:16])

    def test_duplicate_completion_and_clock_rollback_cannot_skip_sites(self):
        ident,_=claim_rotation(self.db,instant(3));self.complete(ident)
        finish_rotation(self.db,ident,instant(3));finish_rotation(self.db,ident,instant(3))
        self.assertIsNone(claim_rotation(self.db,instant(2)))
        self.assertEqual(claim_rotation(self.db,instant(4))[1],self.sources[8:16])

    def test_reordered_registry_cannot_silently_change_cursor(self):
        with self.assertRaises(ValueError):configure(self.db,list(reversed(self.sources)))

    def test_exact_ten_million_token_budget_survives_reopen(self):
        bid=self.batch(10_000_000);reserve_batch(self.db,bid,instant(1))
        self.db.close();self.db=connect(self.root)
        other=self.batch(1)
        with self.assertRaises(DailyBudgetReached):reserve_batch(self.db,other,instant(1))
        self.assertEqual(budget_used(self.db,day(instant(1))),100_000_000)

    def test_prior_day_pending_and_today_completion_remain_reserved(self):
        bid=self.batch(10_000_000);reserve_batch(self.db,bid,instant(1));other=self.batch(1)
        with self.assertRaises(DailyBudgetReached):reserve_batch(self.db,other,instant(2))
        settle_batch(self.db,bid,now=instant(2))
        with self.assertRaises(DailyBudgetReached):reserve_batch(self.db,other,instant(2))
        reserve_batch(self.db,other,instant(3))

    def test_only_explicit_no_charge_releases_reservation(self):
        bid=self.batch(10_000_000);reserve_batch(self.db,bid,instant(1))
        with self.assertRaises(RuntimeError):reserve_batch(self.db,bid,instant(1))
        settle_batch(self.db,bid,uncharged=True,now=instant(1))
        self.assertEqual(budget_used(self.db,day(instant(1))),0)

    def test_concurrent_connections_cannot_both_take_full_budget(self):
        first=self.batch(6_000_000);second=self.batch(6_000_000)
        with closing(connect(self.root)) as other:
            reserve_batch(self.db,first,instant(1))
            with self.assertRaises(DailyBudgetReached):reserve_batch(other,second,instant(1))

    def test_budget_uses_korean_calendar(self):
        self.assertEqual(day(datetime(2026,10,1,15,0,tzinfo=timezone.utc)),'2026-10-02')

    def test_sync_endpoint_is_impossible_even_with_key(self):
        with self.assertRaises(ValueError):BudgetAPI(self.db,object()).request('POST','/embeddings',{})

    def test_ambiguous_submission_is_reconciled_without_a_second_post(self):
        with self.db:
            self.db.execute("INSERT INTO embeddings(dataset_id,source_id,input_hash,input,tokens) VALUES('a','s','h','Title: a',3)")
        with self.db:
            self.db.execute("INSERT INTO source_runs VALUES(1,'s','complete','{}')")
            self.db.execute("INSERT INTO changes VALUES('s:a','s',1,'{}','c','h','a',NULL,'embedding')")
        self.grant()
        calls=[]
        class API:
            def upload(self,path):return 'file-input'
            def request(self,method,path,body=None,**kw):
                calls.append((method,path))
                if method=='POST':raise TimeoutError('lost response')
                marker=self.marker
                return {'data':[{'id':'batch-remote','metadata':{'wanted_run':marker}}],'has_more':False}
        api=API();tick(self.db,self.root,api=api)
        row=self.db.execute('SELECT * FROM batches').fetchone();api.marker=row['marker']
        self.assertEqual(row['status'],'creating');self.assertEqual(self.db.execute('SELECT count(*) FROM charges').fetchone()[0],1)
        tick(self.db,self.root,api=api)
        self.assertEqual(sum(m=='POST' for m,p in calls),1)
        self.assertEqual(self.db.execute('SELECT remote_id FROM batches').fetchone()[0],'batch-remote')

    def test_obsolete_inputs_never_get_paid_but_submitted_inputs_are_preserved(self):
        with self.db:
            self.db.execute("INSERT INTO source_runs VALUES(1,'s','complete','{}')")
            for ident in ('old','latest','submitted'):
                self.db.execute("INSERT INTO embeddings(dataset_id,source_id,input_hash,input,tokens) VALUES(?,'s','h','text',3)",(ident,))
            self.db.execute("INSERT INTO changes VALUES('s:a','s',1,'{}','c','h','latest',NULL,'embedding')")
        self.grant()
        prepared=eb.make_batch(self.db,100)
        with self.db:
            active=self.batch(3)
            self.db.execute("UPDATE batches SET status='submitted' WHERE id=?",(active,))
            self.db.execute("UPDATE embeddings SET batch_id=? WHERE dataset_id='submitted'",(active,))
        discard_obsolete_unsubmitted(self.db)
        self.assertEqual([x[0] for x in self.db.execute('SELECT dataset_id FROM embeddings ORDER BY dataset_id')],['latest','submitted'])
        self.assertEqual(self.db.execute("SELECT batch_id FROM embeddings WHERE dataset_id='latest'").fetchone()[0],None)
        self.assertEqual(self.db.execute('SELECT status FROM batches WHERE id=?',(prepared['id'],)).fetchone()[0],'retried')

    def test_same_text_can_leave_identity_hold_without_a_new_paid_input(self):
        import array
        from refresh_batch import prepare_changes
        metadata={'title':'Title','description':'','_refresh_hold':'ambiguous_native_identity'}
        original=self.root/'original.sqlite3'
        with closing(sqlite3.connect(original)) as old:
            old.execute('PRAGMA journal_mode=WAL')
            old.execute('CREATE TABLE embeddings(dataset_id TEXT,input_hash TEXT,exclusion TEXT,vector BLOB)')
            old.commit()
        with self.db:
            self.db.execute("INSERT INTO source_runs VALUES(1,'s','complete','{}')")
            self.db.execute("INSERT INTO changes VALUES('s:a','s',1,?,'c','h',NULL,NULL,'pending')",(json.dumps(metadata),))
        self.grant()
        encoder=SimpleNamespace(encoding_for_model=lambda _:SimpleNamespace(encode_ordinary=lambda text:list(text.encode())))
        with patch.dict(sys.modules,{'tiktoken':encoder}):
            prepare_changes(self.db,original)
            self.assertEqual(self.db.execute('SELECT state FROM changes').fetchone()[0],'excluded')
            metadata.pop('_refresh_hold')
            with self.db:self.db.execute("UPDATE changes SET metadata=?,state='pending',content_hash='new'",(json.dumps(metadata),))
            self.grant()
            prepare_changes(self.db,original)
        self.assertEqual(self.db.execute('SELECT state FROM changes').fetchone()[0],'embedding')
        self.assertEqual(self.db.execute('SELECT count(*) FROM embeddings').fetchone()[0],1)
        self.assertIsNone(self.db.execute('SELECT exclusion FROM embeddings').fetchone()[0])


class ProviderSafety(unittest.TestCase):
    def test_ckan_prefetch_is_bounded_and_keeps_projection(self):
        urls=next_pages('https://example.org/api/3/action/package_search?start=0&rows=1000&sort=id+asc&fl=id,title',
                        json.dumps({'success':True,'result':{'count':2200}}).encode(),4)
        self.assertEqual(len(urls),2);self.assertIn('fl=id%2Ctitle',urls[0]);self.assertIn('start=2000',urls[1])
    def test_point_in_time_cursor_is_never_guessed(self):
        self.assertEqual(next_pages('https://example.org/search?pitId=one&searchAfterSort=a',b'{"result":{"count":10}}',3),[])
    def test_private_and_unregistered_redirect_destinations_are_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            client=ProviderHTTP(tmp,{'hosts':['example.org'],'parallel_requests':1})
            try:
                with self.assertRaises(ValueError):client.validate('http://169.254.169.254/latest/meta-data/')
                with patch('refresh_http.socket.getaddrinfo',return_value=[(0,0,0,'',('127.0.0.1',80))]):
                    with self.assertRaises(ValueError):client.validate('http://example.org/')
            finally:client.close()
    def test_tags_affect_hash_but_check_time_and_order_do_not(self):
        a={'title':'A','subjects':[{'label':'B'},{'label':'C'}],'checked_at':'old'}
        self.assertEqual(content_hash(a),content_hash({**a,'subjects':list(reversed(a['subjects'])),'checked_at':'new'}))
        self.assertNotEqual(content_hash(a),content_hash({**a,'subjects':[{'label':'D'}]}))
        self.assertNotEqual(content_hash({**a,'metadata_url':'https://example.org/old'}),content_hash({**a,'metadata_url':'https://example.org/new'}))


class IsolatedCollection(unittest.TestCase):
    def test_adapter_changes_only_draft_and_excluded_ids_never_enter_queue(self):
        import catalog
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);base=root/'base.sqlite3'
            with closing(sqlite3.connect(base)) as db,db:
                db.execute('CREATE TABLE datasets(id TEXT PRIMARY KEY,source_id TEXT,title TEXT,description TEXT,metadata TEXT,mappings TEXT,fingerprint TEXT,checked_at TEXT)')
                record=catalog.normalize({'source_id':'kosis','external_id':'a','title':'Old','url':'https://kosis.kr/a','description':'verified description','native_catalog_paths':['Old path']})
                db.execute('INSERT INTO datasets VALUES(?,?,?,?,?,?,?,?)',('kosis:a','kosis','Old','verified description',json.dumps(record),'[]',record['fingerprint'],record['checked_at']))
            profile={'id':'kosis','parallel_requests':1,'hosts':['kosis.kr']}
            collector=Collector(root/'state',base,1,profile)
            try:
                collector.store('kosis',[{'external_id':'a','title':'New','description':'','url':'https://kosis.kr/a','native_catalog_path':'New path'},
                                         {'external_id':'b','title':'Removed','url':'https://kosis.kr/b'}])
                with collector.database() as db:
                    value=json.loads(db.execute("SELECT metadata FROM datasets WHERE id='kosis:a'").fetchone()[0])
                    self.assertEqual(value['native_catalog_paths'],['New path'])
                    self.assertEqual(value['description'],'verified description')
                    with self.assertRaises(sqlite3.OperationalError):db.execute('DELETE FROM datasets')
                with closing(connect(root/'state')) as db:
                    with db:db.execute("INSERT INTO excluded VALUES('kosis:b','approved')")
                    result=collector.enqueue(db)
                    self.assertEqual((result['changed'],result['previously_removed_suppressed']),(1,1))
                    self.assertEqual(db.execute('SELECT dataset_id FROM changes').fetchall()[0][0],'kosis:a')
                with closing(sqlite3.connect(base)) as db:self.assertEqual(db.execute('SELECT title FROM datasets').fetchone()[0],'Old')
            finally:collector.http.close()



class RefreshConcurrency(unittest.TestCase):
    def test_batch_starts_before_slow_source_finishes(self):
        import refresh
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);db=connect(root);configure(db,[f's{i}' for i in range(40)])
            rotation,sites=claim_rotation(db)
            args=SimpleNamespace(root=root,catalog=root/'catalog',vectors=root/'vectors',profiles=root/'profiles')
            trace=[]
            async def scenario():
                batch_started=asyncio.Event();source_done=asyncio.Event()
                async def create(*argv,**kw):
                    is_batch='batch' in argv
                    class Process:
                        async def wait(self):
                            if is_batch:
                                trace.append('batch_started');batch_started.set();await source_done.wait()
                            else:
                                await batch_started.wait();trace.append('source_done');source_done.set()
                            return 0
                    return Process()
                with patch('refresh.asyncio.create_subprocess_exec',side_effect=create):
                    await asyncio.wait_for(refresh.collect_group(args,db,rotation,sites[:1],1),timeout=2)
            try:asyncio.run(scenario())
            finally:db.close()
            self.assertLess(trace.index('batch_started'),trace.index('source_done'))

    def test_busy_batch_lock_never_starts_another_paid_worker(self):
        import fcntl
        import refresh
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            with (root/'batch.lock').open('a') as lock,patch('refresh_batch.tick') as tick:
                fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
                refresh.batch_step(SimpleNamespace(root=root),None)
                tick.assert_not_called()


if __name__=='__main__':unittest.main()
