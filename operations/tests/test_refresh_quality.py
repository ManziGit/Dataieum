import json
import gzip
import io
from types import SimpleNamespace
from pathlib import Path
import sqlite3
import tempfile
import time
import unittest
from unittest.mock import patch
import sys
sys.path[:0]=[str(Path(__file__).resolve().parents[1]),str(Path(__file__).resolve().parents[2])]
from refresh_state import connect,content_hash
from refresh_quality import (inspect_record,identity_keys,record_exclusion,allowed,save_result,
                             result,audit,address,validate_public_url,check_delta,check_pending)

def response(code=200,text='',url='https://example.org/dataset/abcdefgh',kind='text/html'):
    if '<h1>' in text:text+='<link rel="canonical" href="'+url+'">'
    return {'code':code,'text':text,'url':url,'type':kind,'binary':False,'truncated':False}
def record():
    return {'id':'s:abcdefgh','source_id':'s','external_id':'abcdefgh','title':'Official dataset',
            'url':'https://example.org/dataset/abcdefgh',
            'metadata_url':'https://example.org/api?id=abcdefgh'}
class Quality(unittest.TestCase):
    def test_plain_200_and_generic_title_never_pass(self):
        self.assertEqual(inspect_record(record(),lambda u:response(text='<h1>Portal</h1>',url=u),[])['status'],'hold')
    def test_exact_page_identity_passes(self):
        self.assertEqual(inspect_record(record(),lambda u:response(text='<h1>Official dataset</h1>',url=u),[])['status'],'verified')
    def test_shell_requires_exact_official_metadata_identity(self):
        def fetch(u):return response(text='{"result":{"id":"abcdefgh","title":"Official dataset"}}' if '/api?' in u else '<div id="app"></div>',url=u,kind='application/json' if '/api?' in u else 'text/html')
        self.assertEqual(inspect_record(record(),fetch,['example.org'])['status'],'verified')
        self.assertEqual(inspect_record(record(),fetch,[])['status'],'hold')
    def test_wrong_api_identity_is_held(self):
        self.assertEqual(inspect_record(record(),lambda u:response(text='{"result":{"id":"wrong"}}',url=u,kind='application/json'),['example.org'])['status'],'hold')
    def test_missing_needs_repetition_but_block_and_timeout_are_not_deletion(self):
        self.assertEqual(inspect_record(record(),lambda u:response(404,url=u),[])['status'],'repeat')
        self.assertEqual(inspect_record(record(),lambda u:response(403,url=u),[])['status'],'hold')
        self.assertEqual(inspect_record(record(),lambda u:response(429,url=u),[])['status'],'hold')
        def timed(u):raise TimeoutError()
        self.assertEqual(inspect_record(record(),timed,[])['status'],'hold')
    def test_homepage_redirect_is_not_the_dataset(self):
        r=inspect_record(record(),lambda u:response(text='<h1>Official dataset</h1>',url='https://example.org/'),[])
        self.assertEqual(r['reason'],'redirected_to_homepage')
    def test_error_word_in_real_content_does_not_make_soft_404(self):
        self.assertEqual(inspect_record(record(),lambda u:response(text='<h1>Official dataset</h1><p>Error 404 statistics</p>',url=u),[])['status'],'verified')
    def test_shared_homepage_is_not_a_tombstone_identity(self):
        a={**record(),'url':'https://example.org/','metadata_url':'https://example.org/'}
        self.assertEqual(identity_keys('s:abcdefgh',a),{'s:abcdefgh'})
    def test_kosis_requires_both_ids_and_official_table_title(self):
        m={**record(),'url':'https://kosis.kr/statHtml/statHtml.do?orgId=101&tblId=DT_A','title':'통계표 제목'}
        body='<input name="orgId" value="101"><input name="tblId" value="DT_A"><input name="tblNm" value="통계표 제목">'
        self.assertEqual(inspect_record(m,lambda u:response(text=body,url=u),[])['status'],'verified')
        self.assertEqual(inspect_record(m,lambda u:response(text=body.replace('DT_A','DT_B'),url=u),[])['status'],'hold')
    def test_changed_official_title_does_not_approve_stale_metadata(self):
        self.assertEqual(inspect_record(record(),lambda u:response(text='{"result":{"id":"abcdefgh","title":"Different dataset"}}',url=u,kind='application/json'),['example.org'])['status'],'hold')
    def test_compressed_response_cannot_expand_past_the_limit(self):
        from refresh_quality import read_response,MAX_BODY
        data=io.BytesIO(gzip.compress(b'x'*(MAX_BODY*10)))
        response=SimpleNamespace(headers={'Content-Encoding':'gzip'},read1=data.read1)
        self.assertEqual(len(read_response(response)),MAX_BODY+1)
    def test_private_address_and_credential_urls_rejected(self):
        with self.assertRaises(ValueError):validate_public_url('https://user:pass@example.org/')
        with patch('refresh_quality.socket.getaddrinfo',return_value=[(0,0,0,'',('127.0.0.1',80))]):
            with self.assertRaises(ValueError):address('example.org',80)

    def test_empty_duplicate_hidden_field_does_not_erase_kosis_title(self):
        m={**record(),'url':'https://kosis.kr/statHtml/statHtml.do?orgId=101&tblId=DT_A','title':'통계표 제목'}
        body='<input name="orgId" value="101"><input name="tblId" value="DT_A"><input name="tblNm" value="통계표 제목"><input name="tblNm" value="">'
        self.assertEqual(inspect_record(m,lambda u:response(text=body,url=u),[])['status'],'verified')
    def test_seoul_path_and_title_must_both_match_hidden_detail(self):
        m={**record(),'url':'https://data.seoul.go.kr/dataList/DT123/S/2/datasetView.do'}
        body='<input name="infId" value="DT123"><input name="infNm" value="Official dataset">'
        self.assertEqual(inspect_record(m,lambda u:response(text=body,url=u),[])['status'],'verified')
        self.assertEqual(inspect_record(m,lambda u:response(text=body.replace('DT123','DT456'),url=u),[])['status'],'hold')
    def test_daegu_embedded_detail_checks_id_and_title(self):
        m={**record(),'url':'https://data.daegu.go.kr/open/data/dataView.do?dataSetId=abcdefgh'}
        body='<script>const vm={dataSetInfo: {"dataSetId":"abcdefgh","dataName":"Official dataset"}};</script>'
        self.assertEqual(inspect_record(m,lambda u:response(text=body,url=u),[])['status'],'verified')
        self.assertEqual(inspect_record(m,lambda u:response(text=body.replace('Official dataset','Wrong title'),url=u),[])['status'],'hold')
    def test_whole_catalog_is_not_downloaded_again_for_each_record(self):
        m={**record(),'metadata_url':'https://example.org/all-catalog.zip'};calls=[]
        def fetch(u):calls.append(u);return response(url=u)
        self.assertEqual(inspect_record(m,fetch,['example.org'])['status'],'hold')
        self.assertEqual(calls,[m['url']])

class Boundaries(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name);self.db=connect(self.root)
        self.m=record();self.h=content_hash(self.m)
        with self.db:
            self.db.execute("INSERT INTO source_runs VALUES(1,'s','complete','{}')")
            self.db.execute("INSERT INTO changes VALUES('s:abcdefgh','s',1,?,?,'input',NULL,NULL,'ready')",(json.dumps(self.m),self.h))
    def tearDown(self):self.db.close();self.tmp.cleanup()
    def row(self):return self.db.execute('SELECT * FROM changes').fetchone()
    def grant(self):
        with self.db:save_result(self.db,self.row(),result('verified','test_evidence'))
    def test_gate_rejects_missing_stale_expired_and_new_tombstone(self):
        self.assertFalse(allowed(self.db,self.row()))
        self.grant();self.assertTrue(allowed(self.db,self.row()))
        with self.db:self.db.execute('UPDATE quality SET expires_at=0')
        self.assertFalse(allowed(self.db,self.row()))
        self.grant()
        with self.db:record_exclusion(self.db,'s:old',self.m,'approved')
        self.assertFalse(allowed(self.db,self.row()))
    def test_subsequent_backup_append_is_loaded(self):
        import refresh
        p=self.root/'deletions.jsonl';p.write_text(json.dumps({'id':'s:a','metadata':'{}'})+'\n')
        refresh.load_exclusions(self.db,[p])
        with p.open('a') as f:f.write(json.dumps({'id':'s:b','metadata':'{}'})+'\n')
        refresh.load_exclusions(self.db,[p])
        self.assertIsNotNone(self.db.execute("SELECT 1 FROM excluded WHERE dataset_id='s:b'").fetchone())
    def test_complete_audit_has_every_frozen_id_and_same_hash(self):
        folder=self.root/'audit'
        with patch('refresh_quality.Fetcher',return_value=lambda u:response(text='<h1>Official dataset</h1>',url=u)):
            status=audit(self.root,folder,{'sources':[]},expected=1)
        self.assertEqual((status['stage'],status['target_records'],status['checked_records']),('complete',1,1))
        self.assertTrue(allowed(self.db,self.row()))
    def test_audit_resume_does_not_repeat_completed_ids(self):
        m={**self.m,'id':'s:ijklmnop','external_id':'ijklmnop','url':'https://example.org/dataset/ijklmnop'}
        with self.db:self.db.execute("INSERT INTO changes VALUES('s:ijklmnop','s',1,?,'v2','input',NULL,NULL,'ready')",(json.dumps(m),))
        folder=self.root/'resume';calls=[]
        def fetch(u):calls.append(u);return response(text='<h1>Official dataset</h1>',url=u)
        with patch('refresh_quality.Fetcher',return_value=fetch):
            first=audit(self.root,folder,{'sources':[]},expected=2,limit=1)
            second=audit(self.root,folder,{'sources':[]},expected=2)
        self.assertEqual(first['checked_records'],1)
        self.assertEqual((second['stage'],second['checked_records']),('complete',2))
        self.assertEqual(len(calls),2)
    def test_repeat_missing_is_not_a_first_request_deletion(self):
        with self.db:self.db.execute("UPDATE changes SET state='pending'")
        check_pending(self.db,{'sources':[]},fetch=lambda u:response(404,url=u))
        self.assertEqual(self.db.execute('SELECT status FROM quality').fetchone()[0],'hold')
        with self.db:self.db.execute('UPDATE quality SET checked_at=checked_at-61')
        check_pending(self.db,{'sources':[]},fetch=lambda u:response(404,url=u))
        self.assertEqual(self.db.execute('SELECT status FROM quality').fetchone()[0],'excluded')
    def test_unverified_input_cannot_reserve_or_submit_paid_batch(self):
        from refresh_batch import BudgetAPI,QualityGateBlocked
        from unittest.mock import Mock
        with self.db:
            self.db.execute("INSERT INTO batches(marker,status,tokens,count) VALUES('guard','prepared',10,1)")
            bid=self.db.execute("SELECT id FROM batches WHERE marker='guard'").fetchone()[0]
            self.db.execute("INSERT INTO embeddings(dataset_id,source_id,input_hash,tokens,batch_id) VALUES('key','s','input',10,?)",(bid,))
            self.db.execute("UPDATE changes SET embedding_key='key'")
        api=Mock()
        with self.assertRaises(QualityGateBlocked):
            BudgetAPI(self.db,api).request('POST','/batches',{'endpoint':'/v1/embeddings','completion_window':'24h','metadata':{'wanted_run':'guard'}})
        api.request.assert_not_called()
        self.assertEqual(self.db.execute('SELECT count(*) FROM charges').fetchone()[0],0)
    def test_renamed_id_with_same_deleted_title_is_held_not_auto_deleted(self):
        m={**self.m,'publisher':'Official agency'}
        with self.db:
            self.db.execute("UPDATE changes SET metadata=?,state='pending'",(json.dumps(m),))
            record_exclusion(self.db,'s:removed',{**m,'external_id':'removed-id','url':'https://example.org/dataset/removed-id','metadata_url':''},'approved')
        check_pending(self.db,{'sources':[]},fetch=lambda u: (_ for _ in ()).throw(AssertionError('must hold before network')))
        q=self.db.execute('SELECT status,reason FROM quality').fetchone()
        self.assertEqual(tuple(q),('hold','possible_deleted_identity'))
    def test_bad_metadata_is_held_without_stopping_other_records(self):
        with self.db:self.db.execute("UPDATE changes SET metadata='[1,2]',state='pending'")
        check_pending(self.db,{'sources':[]},fetch=lambda u: (_ for _ in ()).throw(AssertionError('bad metadata must not be fetched')))
        self.assertEqual(tuple(self.db.execute('SELECT status,reason FROM quality').fetchone()),('hold','invalid_metadata'))
    def test_expired_ready_vector_is_revalidated_without_paid_work(self):
        self.grant()
        with self.db:self.db.execute('UPDATE quality SET expires_at=0')
        check_pending(self.db,{'sources':[]},fetch=lambda u:response(text='<h1>Official dataset</h1>',url=u))
        self.assertTrue(allowed(self.db,self.row()))
        self.assertEqual(self.row()['state'],'ready')
    def test_expired_unsubmitted_embedding_returns_to_rebuildable_pending(self):
        from refresh_batch import discard_obsolete_unsubmitted
        self.grant()
        with self.db:
            self.db.execute("INSERT INTO embeddings(dataset_id,source_id,input_hash,input,tokens) VALUES('key','s','input','text',10)")
            self.db.execute("UPDATE changes SET state='embedding',embedding_key='key'")
            self.db.execute('UPDATE quality SET expires_at=0')
        discard_obsolete_unsubmitted(self.db)
        self.assertEqual(self.row()['state'],'pending');self.assertIsNone(self.row()['embedding_key'])
        self.assertEqual(self.db.execute("SELECT count(*) FROM embeddings WHERE dataset_id='key'").fetchone()[0],0)
    def test_all_bytes_version_not_only_id_is_required(self):
        self.grant()
        with self.db:self.db.execute("UPDATE changes SET content_hash='new-version'")
        self.assertFalse(allowed(self.db,self.row()))
    def test_publication_rechecks_tombstone_after_freeze(self):
        self.grant();delta=sqlite3.connect(':memory:')
        delta.executescript('CREATE TABLE changes(dataset_id TEXT,metadata TEXT,content_hash TEXT)')
        delta.execute('INSERT INTO changes VALUES(?,?,?)',('s:abcdefgh',json.dumps(self.m),self.h))
        check_delta(self.db,delta)
        with self.db:record_exclusion(self.db,'s:abcdefgh',self.m,'new deletion')
        with self.assertRaisesRegex(RuntimeError,'quality gate'):check_delta(self.db,delta)
        delta.close()
if __name__=='__main__':unittest.main()
