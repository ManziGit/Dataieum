from datetime import datetime,timezone
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import refresh_maintenance as maintenance


class Maintenance(unittest.TestCase):
    def test_four_am_korean_window_and_no_late_downtime(self):
        self.assertTrue(maintenance.within_window(datetime(2026,9,27,19,0,tzinfo=timezone.utc)))
        self.assertTrue(maintenance.within_window(datetime(2026,9,27,19,9,tzinfo=timezone.utc)))
        self.assertFalse(maintenance.within_window(datetime(2026,9,27,19,10,tzinfo=timezone.utc)))
        self.assertFalse(maintenance.within_window(datetime(2026,9,27,18,59,tzinfo=timezone.utc)))

    def test_gate_preserves_auth_and_responds_before_proxy(self):
        text='site {\n route {\n basic_auth {\n keep-auth\n }\n reverse_proxy atlas:8000 {\n }\n }\n}'
        changed=maintenance.gate_content(text)
        self.assertLess(changed.index('keep-auth'),changed.index('respond'))
        self.assertLess(changed.index('respond'),changed.index('reverse_proxy'))
        self.assertIn('503',changed)
        with self.assertRaises(ValueError):maintenance.gate_content(text+text)

    def test_interrupted_apply_restores_before_restart_or_reopening(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);(root/'apply-started').touch();state={'root':tmp,'stage':'applying','closed_at':1};events=[]
            with patch.object(maintenance,'close_site',side_effect=lambda s:events.append('close')),patch.object(maintenance,'builder',side_effect=lambda s,a:events.append(a)),patch.object(maintenance,'start_and_validate',side_effect=lambda s,u:events.append(('verify',u))),patch.object(maintenance,'reopen',side_effect=lambda s:events.append('open')),patch.object(maintenance,'save',side_effect=lambda s,p,**kw:events.append(p)),patch.object(maintenance,'unacknowledge'):
                maintenance.recover(state)
            self.assertEqual(events,['close','rollback',('verify',False),'open','rolled_back'])

    def test_failed_recovery_never_reopens(self):
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp)/'apply-started').touch()
            with patch.object(maintenance,'close_site'),patch.object(maintenance,'builder',side_effect=RuntimeError('undo failed')),patch.object(maintenance,'reopen') as reopen:
                with self.assertRaisesRegex(RuntimeError,'undo failed'):maintenance.recover({'root':tmp,'stage':'applying','closed_at':1})
                reopen.assert_not_called()

    def test_completed_verified_update_finishes_after_reboot_without_reapplying(self):
        with patch.object(maintenance,'close_site'),patch.object(maintenance,'start_and_validate') as validate,patch.object(maintenance,'reopen'),patch.object(maintenance,'acknowledge') as acknowledge,patch.object(maintenance,'builder') as builder:
            state={'stage':'validated','closed_at':1,'root':'/unused'};maintenance.recover(state)
            validate.assert_called_once_with(state,True);acknowledge.assert_called_once_with(state);builder.assert_not_called()

    def test_rollback_requeues_only_matching_version_not_new_work(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);folder=root/'maintenance';folder.mkdir()
            with sqlite3.connect(root/'embeddings.sqlite3') as db:
                db.executescript("CREATE TABLE changes(dataset_id TEXT,content_hash TEXT,state TEXT);INSERT INTO changes VALUES('same','v1','published'),('new','v2','ready');")
            with sqlite3.connect(folder/'delta.sqlite3') as db:
                db.executescript("CREATE TABLE changes(dataset_id TEXT,content_hash TEXT);INSERT INTO changes VALUES('same','v1'),('new','v1');")
            with patch.object(maintenance,'ROOT',root):maintenance.unacknowledge({'root':str(folder)})
            with sqlite3.connect(root/'embeddings.sqlite3') as db:
                self.assertEqual(db.execute('SELECT * FROM changes ORDER BY dataset_id').fetchall(),[('new','v2','ready'),('same','v1','ready')])


if __name__=='__main__':unittest.main()
