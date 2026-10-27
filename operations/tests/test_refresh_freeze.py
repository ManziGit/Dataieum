import json
from datetime import datetime,timezone
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from refresh_run import freeze,collector_action


class Freeze(unittest.TestCase):
    def test_new_collection_does_not_occupy_four_am_maintenance_window(self):
        self.assertEqual(collector_action(datetime(2026,9,27,15,5,tzinfo=timezone.utc)),'batch')
        self.assertEqual(collector_action(datetime(2026,9,27,19,5,tzinfo=timezone.utc)),'batch')
        self.assertEqual(collector_action(datetime(2026,9,27,20,5,tzinfo=timezone.utc)),'tick')

    def test_only_complete_ready_matching_versions_enter_publication(self):
        with tempfile.TemporaryDirectory() as tmp:
            db=sqlite3.connect(':memory:')
            db.executescript('''CREATE TABLE changes(dataset_id TEXT,source TEXT,rotation INTEGER,state TEXT,exclusion TEXT,metadata TEXT,content_hash TEXT,input_hash TEXT,embedding_key TEXT);
              CREATE TABLE source_runs(rotation INTEGER,source TEXT,status TEXT);
              CREATE TABLE embeddings(dataset_id TEXT,vector BLOB,exclusion TEXT,input_hash TEXT);
              INSERT INTO source_runs VALUES(1,'complete','complete'),(1,'incomplete','unverified');''')
            from refresh_quality import setup
            setup(db)
            db.execute('CREATE TABLE excluded(dataset_id TEXT PRIMARY KEY,reason TEXT)')
            for ident,source,status,exclusion in [('valid','complete','ready',None),('running','complete','pending',None),('unverified','incomplete','ready',None),('excluded','complete','ready','held')]:
                db.execute('INSERT INTO changes VALUES(?,?,1,?,?,?,?,?,?)',(ident,source,status,exclusion,'{}','content','hash',ident))
                db.execute('INSERT INTO embeddings VALUES(?,?,NULL,?)',(ident,b'vector','hash'))
            db.execute("INSERT INTO quality VALUES('valid','content','verified','fixture','{}',0,9999999999)")
            self.assertEqual(freeze(db,Path(tmp)/'first.sqlite3'),1)
            db.execute("UPDATE embeddings SET input_hash='stale' WHERE dataset_id='valid'")
            with self.assertRaisesRegex(RuntimeError,'identities differ'):freeze(db,Path(tmp)/'second.sqlite3')
            db.close()


if __name__=='__main__':unittest.main()
