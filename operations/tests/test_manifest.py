import contextlib
import io
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from reconcile_topic_manifest import reconcile


class Manifest(unittest.TestCase):
    def fixture(self,root):
        graph=root/'graph.sqlite3';db=sqlite3.connect(graph)
        db.executescript("CREATE TABLE state(key TEXT,value TEXT); INSERT INTO state VALUES('complete','1'),('count','2');"
            "CREATE TABLE records(id TEXT,band TEXT); INSERT INTO records VALUES('a','high'),('b','low');"
            "CREATE TABLE links(id TEXT); INSERT INTO links VALUES('a'),('b');"
            "CREATE TABLE counts(band TEXT,main_id TEXT,topic TEXT,n INTEGER);"
            "INSERT INTO counts VALUES('high','','',1),('low','','',1),('unclassified','','',0),"
            "('high','M01','M01-S01',1),('low','M01','M01-S02',1);")
        db.commit();db.close()
        manifest=root/'manifest.json';manifest.write_text(json.dumps({'bytes':0,'sha256':'0'*64,'counts':{}}))
        return graph,manifest

    def test_entire_graph_is_counted_and_data_remains_identical(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);graph,manifest=self.fixture(root);before=graph.read_bytes()
            with contextlib.redirect_stdout(io.StringIO()):reconcile(graph,manifest,root/'report.json')
            result=json.loads(manifest.read_text())
            self.assertEqual(result['counts'],{'high':1,'low':1,'unclassified':0,'total':2,'links':2})
            self.assertEqual(graph.read_bytes(),before)

    def test_inconsistent_aggregates_do_not_get_a_new_manifest(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);graph,manifest=self.fixture(root);before=manifest.read_bytes()
            db=sqlite3.connect(graph);db.execute("UPDATE counts SET n=9 WHERE band='high' AND topic=''");db.commit();db.close()
            with self.assertRaises(RuntimeError):reconcile(graph,manifest,root/'report.json')
            self.assertEqual(manifest.read_bytes(),before)


if __name__=='__main__':unittest.main()
