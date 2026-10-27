import base64
from contextlib import closing
import json
from pathlib import Path
import sqlite3
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import refresh_publish_data as pub
import numpy as np
import faiss
from discovery_harness import keyword_index,coverage_index,reference_years
from discovery_harness.vector_index import _identity,_sha,VectorIndex,IndexUnavailable


def vector(position):
    v=np.zeros(1536,dtype=np.float32);v[position]=1
    return v.tobytes()


class Publication(unittest.TestCase):
    def test_flat_publication(self):self.exercise(False)

    def test_production_ivfpq_publication(self):self.exercise(True)

    def test_recovery_after_every_durable_phase(self):
        for phase in ['catalog','keyword','graph','updates','mapping','coverage','faiss']:
            with self.subTest(phase=phase):self.exercise(False,phase)

    def exercise(self,approximate,fail_phase=None):
        with tempfile.TemporaryDirectory() as tmp:
            base=Path(tmp)/'base';root=Path(tmp)/'new';base.mkdir();root.mkdir();(base/'topics').mkdir();gen=base/'index/generation-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';gen.mkdir(parents=True)
            paths={'catalog':base/'catalog.sqlite3','keyword':base/'search.sqlite3','topics':base/'topics','index':base/'index','coverage':base/'coverage.sqlite3','embeddings':base/'embeddings.sqlite3'}
            records=[]
            for i,band in enumerate(['high','low','unclassified']):
                m={'id':f's:{i}','source_id':'s','title':f'Oldword{i}','description':'Old description','publisher':'Official','url':f'https://example.org/{i}','period':'2020','region':'Korea','fingerprint':str(i),'checked_at':'old'}
                records.append((m['id'],'s',m['title'],m['description'],json.dumps(m),'[]',str(i),'old'))
            with closing(sqlite3.connect(paths['catalog'])) as db,db:
                db.executescript('CREATE TABLE datasets(id TEXT PRIMARY KEY,source_id TEXT,title TEXT,description TEXT,metadata TEXT,mappings TEXT,fingerprint TEXT,checked_at TEXT); CREATE TABLE sources(id TEXT PRIMARY KEY,info TEXT NOT NULL,last_sync TEXT,last_error TEXT NOT NULL);')
                db.executemany('INSERT INTO datasets VALUES(?,?,?,?,?,?,?,?)',records);db.execute("INSERT INTO sources VALUES('s','{}',NULL,'')")
            keyword_index.build(paths['catalog'],paths['keyword'])
            indexed=base/'years.sqlite3'
            reference_years.build(paths['catalog'],paths['keyword'],indexed)
            indexed.replace(paths['keyword'])
            with closing(sqlite3.connect(base/'topics/confidence.sqlite3')) as db,db:
                db.executescript('''CREATE TABLE records(id TEXT PRIMARY KEY,band TEXT,score REAL,source TEXT,title TEXT);
                  CREATE TABLE links(dataset_id TEXT,topic TEXT,band TEXT,score REAL,alpha REAL,PRIMARY KEY(dataset_id,topic));
                  CREATE TABLE primary_links(dataset_id TEXT PRIMARY KEY,topic TEXT,band TEXT,score REAL,alpha REAL);
                  CREATE TABLE topics(id TEXT PRIMARY KEY,main_id TEXT,main_name TEXT,name TEXT,definition TEXT);
                  CREATE TABLE counts(band TEXT,main_id TEXT,topic TEXT,n INTEGER);
                  CREATE TABLE primary_counts(band TEXT,main_id TEXT,topic TEXT,n INTEGER);
                  CREATE TABLE classification_holds(dataset_id TEXT PRIMARY KEY,original_band TEXT,original_score REAL,excluded_links INTEGER);
                  CREATE TABLE membership_corrections(dataset_id TEXT,topic TEXT,original_link TEXT,reason TEXT,evidence_url TEXT,PRIMARY KEY(dataset_id,topic));
                  CREATE TABLE state(key TEXT PRIMARY KEY,value TEXT);''')
                db.execute("INSERT INTO topics VALUES('t','m','Main','Topic','Definition')")
                for i,band in enumerate(['high','low','unclassified']):
                    db.execute('INSERT INTO records VALUES(?,?,?,?,?)',(f's:{i}',band,[1,.2,.1][i],'s',f'Oldword{i}'))
                    for table in ['counts','primary_counts']:
                        db.execute(f'INSERT INTO {table} VALUES(?,?,?,1)',(band,'',''))
                        if i<2:
                            for topic in ['','t']:db.execute(f'INSERT INTO {table} VALUES(?,?,?,1)',(band,'m',topic))
                    if i<2:
                        for table in ['links','primary_links']:db.execute(f'INSERT INTO {table} VALUES(?,?,?,?,?)',(f's:{i}','t',band,[1,.2][i],1))
                db.executemany('INSERT INTO state VALUES(?,?)',[('count','3'),('complete','1'),('source_counts','{"s":3}')])
                db.execute("INSERT INTO classification_holds VALUES('s:2','high',1,1)")
            (base/'topics/manifest.json').write_text(json.dumps({'thresholds':{'high':.25,'low':.15,'relative':.9}}))
            topic=base/'topic-vectors.json';topic.write_text(json.dumps({'topics':[{'id':'t','vector':base64.b64encode(vector(0)).decode()}]}))
            with closing(sqlite3.connect(paths['embeddings'])) as db,db:
                db.execute('CREATE TABLE embeddings(dataset_id TEXT,source_id TEXT,input_hash TEXT,vector BLOB,exclusion TEXT)')
                db.executemany('INSERT INTO embeddings VALUES(?,?,?,?,NULL)',[(f's:{i}','s',str(i)*64,vector(i)) for i in range(3)])
            with closing(sqlite3.connect(gen/'mapping.sqlite3')) as db,db:
                db.execute('CREATE TABLE records(label INTEGER PRIMARY KEY,embedding_rowid INTEGER,dataset_id TEXT,source_id TEXT,input_hash TEXT)')
                db.executemany('INSERT INTO records VALUES(?,?,?,?,?)',[(i,i+1,f's:{i}','s',str(i)*64) for i in range(3)])
            index=faiss.IndexIVFPQ(faiss.IndexFlatIP(1536),1536,2,4,2,faiss.METRIC_INNER_PRODUCT) if approximate else faiss.IndexFlatIP(1536)
            faiss.omp_set_num_threads(1)
            if approximate:
                index.cp.niter=2;index.pq.cp.niter=2
                index.train(np.random.default_rng(1).normal(size=(256,1536)).astype(np.float32))
            index.add(np.stack([np.frombuffer(vector(i),dtype=np.float32) for i in range(3)]));faiss.write_index(index,str(gen/'vectors.faiss'))
            np.save(gen/'sources.npy',np.zeros(3,dtype=np.uint16));np.save(gen/'active.npy',np.ones(3,dtype=bool))
            manifest={'format_version':1,'model':'text-embedding-3-small','dimensions':1536,'version':'four-fields-v1','indexed_vectors':3,'active_vectors':3,'sources':['s'],'source_counts':{'s':3},'approximate':approximate,'algorithm':'IVF-PQ' if approximate else 'FlatIP','nlist':2 if approximate else 0,'pq_m':4 if approximate else 0,'source_identity':{'catalog':_identity(paths['catalog']),'embeddings':_identity(paths['embeddings'])},'built_at':'old','files':{n:{'bytes':(gen/n).stat().st_size,'sha256':_sha(gen/n)} for n in ['mapping.sqlite3','vectors.faiss','sources.npy','active.npy']}}
            (gen/'manifest.json').write_text(json.dumps(manifest));(base/'index/CURRENT').write_text(gen.name)
            coverage_index.build(paths['catalog'],gen/'mapping.sqlite3',paths['coverage'])
            original={p:_sha(p) for p in base.rglob('*') if p.is_file()}
            with closing(sqlite3.connect(root/'delta.sqlite3')) as delta:
                delta.row_factory=sqlite3.Row;delta.execute('CREATE TABLE changes(dataset_id TEXT PRIMARY KEY,source TEXT,metadata TEXT,content_hash TEXT,input_hash TEXT,vector BLOB)')
                for i in [0,2,3]:
                    m={'id':f's:{i}','source_id':'s','title':f'Newword{i}','description':'New description','url':f'https://example.org/{i}','publisher':'Official','period':'2026','region':'Korea','fingerprint':'new','checked_at':'new'}
                    delta.execute('INSERT INTO changes VALUES(?,?,?,?,?,?)',(f's:{i}','s',json.dumps(m),'content','a'*64,vector(0)))
                delta.commit()
                pub.plan_classifications(paths,root,topic)
                pub.prepare_undo(paths,root);pub.begin_apply(paths,root)
                if fail_phase:
                    def interrupt(phase):
                        if phase==fail_phase:raise RuntimeError('injected interruption')
                    with patch.object(pub,'checkpoint',side_effect=interrupt):
                        with self.assertRaisesRegex(RuntimeError,'injected'):
                            pub.apply_catalog_and_topics(paths,root,delta,topic);pub.apply_vectors(paths,root,delta)
                    pub.rollback_data(paths,root);pub.rollback_data(paths,root)
                    self.assert_restored(paths,records)
                    return
                result=pub.apply_catalog_and_topics(paths,root,delta,topic)
                target=pub.apply_vectors(paths,root,delta)
                proof=pub.verify(root,target,paths,delta,None)
                self.assertEqual(result['new_records'],1);self.assertEqual(proof['all_changed_records_verified'],3)
                with closing(sqlite3.connect(root/'catalog-search.sqlite3')) as db:
                    self.assertEqual(db.execute('SELECT year,count(*) FROM reference_years GROUP BY year ORDER BY year').fetchall(),[(2020,1),(2026,3)])
                    self.assertEqual(db.execute('SELECT records FROM reference_year_state').fetchone()[0],4)
                    self.assertFalse(db.execute('SELECT rowid FROM phrases WHERE phrases MATCH ?',(keyword_index.lookup('Oldword0')[1],)).fetchall())
                    self.assertEqual(len(db.execute('SELECT rowid FROM phrases WHERE phrases MATCH ?',(keyword_index.lookup('Newword0')[1],)).fetchall()),1)
                with closing(sqlite3.connect(root/'topics/confidence.sqlite3')) as db:
                    self.assertEqual(db.execute("SELECT band FROM records WHERE id='s:2'").fetchone()[0],'unclassified')
                    self.assertEqual(db.execute("SELECT count(*) FROM links WHERE dataset_id='s:2'").fetchone()[0],0)
                service=VectorIndex(paths['embeddings'],root/'catalog.sqlite3',root/'index',coverage_index=root/'coverage.sqlite3')
                answer=service.search(np.frombuffer(vector(0),dtype=np.float32),limit=3,filter_groups=[{'years':[2026]}])
                self.assertEqual({r['dataset_id'] for r in answer['candidates']},{'s:0','s:2','s:3'})
                # A second day's update must preserve prior negative vector rowids and undo them.
                nextroot=Path(tmp)/'second';nextroot.mkdir();shutil.copyfile(root/'delta.sqlite3',nextroot/'delta.sqlite3')
                with closing(pub.database(nextroot/'delta.sqlite3')) as second:
                    second.execute("UPDATE changes SET input_hash=?,vector=?",('b'*64,vector(1)));second.commit()
                    pub.plan_classifications(paths,nextroot,topic);pub.prepare_undo(paths,nextroot);pub.begin_apply(paths,nextroot)
                    pub.apply_catalog_and_topics(paths,nextroot,second,topic);nexttarget=pub.apply_vectors(paths,nextroot,second)
                    self.assertEqual(pub.verify(nextroot,nexttarget,paths,second,None)['all_changed_records_verified'],3)
                    pub.rollback_data(paths,nextroot)
                # Restore first-day markers: its undo is being tested explicitly below;
                # production keeps only the newest undo after the next successful day.
                for file in [paths['keyword'],paths['coverage']]:
                    with closing(sqlite3.connect(file)) as db,db:
                        for i in [0,2,3]:db.execute('INSERT OR REPLACE INTO refresh_applied VALUES(?,?)',(f's:{i}',i))
                service=VectorIndex(paths['embeddings'],paths['catalog'],paths['index'],coverage_index=paths['coverage'])
                with closing(sqlite3.connect(target/'updates.sqlite3')) as db,db:db.execute("UPDATE embeddings SET input_hash='broken'")
                with self.assertRaises(IndexUnavailable):service.check_current()
                pub.rollback_data(paths,root)
                self.assert_restored(paths,records)
            self.assertEqual(_sha(paths['embeddings']),original[paths['embeddings']])
            self.assertTrue((root/'catalog.sqlite3').is_symlink())

    def assert_restored(self,paths,records):
        with closing(sqlite3.connect(paths['catalog'])) as db:
            self.assertEqual(db.execute('SELECT * FROM datasets ORDER BY id').fetchall(),records)
        with closing(sqlite3.connect(paths['keyword'])) as db:
            self.assertEqual(db.execute('SELECT year,count(*) FROM reference_years GROUP BY year').fetchall(),[(2020,3)])
            self.assertEqual(db.execute('SELECT records FROM reference_year_state').fetchone()[0],3)
            self.assertEqual(len(db.execute('SELECT rowid FROM phrases WHERE phrases MATCH ?',(keyword_index.lookup('Oldword0')[1],)).fetchall()),1)
            self.assertFalse(db.execute('SELECT rowid FROM phrases WHERE phrases MATCH ?',(keyword_index.lookup('Newword0')[1],)).fetchall())
        with closing(sqlite3.connect(paths['topics']/'confidence.sqlite3')) as db:
            self.assertEqual(dict(db.execute('SELECT band,count(*) FROM records GROUP BY band')),{'high':1,'low':1,'unclassified':1})
        service=VectorIndex(paths['embeddings'],paths['catalog'],paths['index'],coverage_index=paths['coverage'])
        result=service.search(np.frombuffer(vector(0),dtype=np.float32),limit=3,filter_groups=[{'years':[2020]}])
        self.assertEqual({r['dataset_id'] for r in result['candidates']},{'s:0','s:1','s:2'})


if __name__=='__main__':unittest.main()
