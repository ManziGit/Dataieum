from contextlib import closing
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from discovery_harness.vector_index import _identity,_sha
from index_lookup import build


class LookupUpgrade(unittest.TestCase):
    def test_full_mapping_is_preserved_and_new_coverage_binds_only_to_copy(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);index=root/'index';generation='generation-'+'a'*32;source=index/generation;source.mkdir(parents=True)
            (index/'CURRENT').write_text(generation)
            with closing(sqlite3.connect(source/'mapping.sqlite3')) as db,db:
                db.executescript('CREATE TABLE records(label INTEGER PRIMARY KEY,embedding_rowid INTEGER NOT NULL,dataset_id TEXT NOT NULL,source_id TEXT NOT NULL,input_hash TEXT NOT NULL);')
                db.executemany('INSERT INTO records VALUES(?,?,?,?,?)',[(0,1,'same','kr','first'),(1,3,'same','us','second')])
            (source/'vectors.faiss').write_bytes(b'unchanged-vector-bytes');(source/'sources.npy').write_bytes(b'unchanged-sources')
            files={p.name:{'bytes':p.stat().st_size,'sha256':_sha(p)} for p in source.iterdir()}
            (source/'manifest.json').write_text(json.dumps({'files':files}))
            coverage=root/'coverage.sqlite3'
            with closing(sqlite3.connect(coverage)) as db,db:
                db.execute('CREATE TABLE manifest(value TEXT)')
                db.execute('INSERT INTO manifest VALUES(?)',(json.dumps({'source_identity':{'mapping':_identity(source/'mapping.sqlite3')},'mapping_sha256':files['mapping.sqlite3']['sha256']}),))
            result=build(index,coverage,root/'next')
            self.assertEqual(result['rows'],2);self.assertTrue(result['all_mapping_rows_equal'])
            self.assertEqual(_sha(source/'mapping.sqlite3'),files['mapping.sqlite3']['sha256'])
            self.assertTrue(all('SEARCH' in p[3] for p in result['query_plan']))
            with closing(sqlite3.connect(root/'next/coverage.sqlite3')) as db:
                updated=json.loads(db.execute('SELECT value FROM manifest').fetchone()[0])
            self.assertEqual(updated['mapping_sha256'],_sha(root/'next/index'/generation/'mapping.sqlite3'))
            with self.assertRaises(FileExistsError):build(index,coverage,root/'next')
