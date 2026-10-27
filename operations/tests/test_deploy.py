from pathlib import Path
import sqlite3
import json
import tempfile
import unittest
from unittest.mock import patch
import sys
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from deploy import replace_upstream,stop_stack,pause_dispatch,resume_dispatch,bind_source,rollback,ensure_dispatch_lock,maintenance_guard


class Deployment(unittest.TestCase):
    def test_unfinished_maintenance_blocks_a_separate_deployment(self):
        with patch('deploy.Path') as path:
            path.return_value.exists.return_value=True
            path.return_value.read_text.return_value='{"stage":"recovery_required"}'
            with self.assertRaisesRegex(RuntimeError,'maintenance recovery'):maintenance_guard()
            path.return_value.read_text.return_value='{"stage":"published"}'
            maintenance_guard()

    def test_dispatch_lock_uses_database_owner_and_preserves_inode(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);(root/'chat-jobs.sqlite3').touch();lock=root/'dispatcher.lock';lock.touch()
            inode=lock.stat().st_ino
            with patch('deploy.os.fchown') as chown:
                ensure_dispatch_lock(root)
                owner=(root/'chat-jobs.sqlite3').stat()
                self.assertEqual(chown.call_args.args[1:],(owner.st_uid,owner.st_gid))
            self.assertEqual(lock.stat().st_ino,inode)
            self.assertEqual(lock.stat().st_mode & 0o777,0o600)

    def test_shared_state_is_resolved_from_mounts_not_release_directory(self):
        cfg={'services':{'atlas':{'volumes':[{'type':'bind','source':'/persistent/jobs','target':'/harness-shared'}]}}}
        self.assertEqual(bind_source(cfg,'atlas','/harness-shared'),Path('/persistent/jobs'))
        cfg['services']['atlas']['volumes']*=2
        with self.assertRaises(ValueError):bind_source(cfg,'atlas','/harness-shared')

    def test_only_upstream_changes_and_auth_is_preserved(self):
        text='site {\n route {\n basic_auth {\n preserved-auth-value\n }\n reverse_proxy old:8000 {\n header_up Host localhost\n }\n }\n}'
        result=replace_upstream(text,'old:8000','new:8000')
        self.assertEqual(result.replace('new:8000','old:8000'),text)
        for invalid in [text.replace('old:8000','other:8000'),text+'\n reverse_proxy old:8000 {\n}']:
            with self.assertRaises(ValueError):replace_upstream(invalid,'old:8000','new:8000')

    def test_frontend_drains_before_dependencies_stop(self):
        with patch('deploy.run') as run:
            stop_stack('/deployment/compose.json')
            self.assertEqual(run.call_args_list[0].args[0][-1],'atlas')
            self.assertEqual(run.call_args_list[1].args[0][-2:],['luna','vector'])

    def test_first_migration_barrier_allows_acceptance_and_completion(self):
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp);db=sqlite3.connect(path/'chat-jobs.sqlite3')
            db.execute('CREATE TABLE chat_jobs(job_id TEXT,status TEXT)')
            db.execute("INSERT INTO chat_jobs VALUES('old','running')");db.commit()
            pause_dispatch(path,True)
            db.execute("INSERT INTO chat_jobs VALUES('new','queued')")
            db.execute("UPDATE chat_jobs SET status='completed' WHERE job_id='old'");db.commit()
            with self.assertRaises(sqlite3.IntegrityError):db.execute("UPDATE chat_jobs SET status='running' WHERE job_id='new'")
            db.rollback();resume_dispatch(path)
            db.execute("UPDATE chat_jobs SET status='running' WHERE job_id='new'");db.commit()
            self.assertFalse((path/'dispatcher.pause').exists());db.close()

    def test_failed_rollback_restores_serving_dispatcher_only_after_old_stops(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            state={'stage':'active','shared':tmp,'legacy_dispatcher':True,
                   'previous_compose':'old.json','caddy_active_sha256':'active'}
            (root/'deployment.json').write_text(json.dumps(state))
            events=[]
            with patch('deploy.sha',return_value='active'), \
                 patch('deploy.pause_dispatch',side_effect=lambda *a:events.append('pause')), \
                 patch('deploy.wait_drained',side_effect=lambda *a:events.append('drain')), \
                 patch('deploy.drop_legacy_barrier'), \
                 patch('deploy.run',side_effect=RuntimeError('old startup failed')), \
                 patch('deploy.stop_stack',side_effect=lambda *a:events.append('stop-old')), \
                 patch('deploy.resume_dispatch',side_effect=lambda *a:events.append('resume')):
                with self.assertRaisesRegex(RuntimeError,'old startup failed'):rollback(root)
            self.assertEqual(events,['pause','drain','pause','drain','stop-old','resume'])

    def test_failed_rollback_does_not_resume_two_workers_when_old_cannot_drain(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            state={'stage':'active','shared':tmp,'legacy_dispatcher':True,
                   'previous_compose':'old.json','caddy_active_sha256':'active'}
            (root/'deployment.json').write_text(json.dumps(state))
            with patch('deploy.sha',return_value='active'),patch('deploy.pause_dispatch'), \
                 patch('deploy.drop_legacy_barrier'), \
                 patch('deploy.wait_drained',side_effect=[None,TimeoutError('still running')]), \
                 patch('deploy.run',side_effect=RuntimeError('old startup failed')), \
                 patch('deploy.resume_dispatch') as resume:
                with self.assertRaisesRegex(TimeoutError,'still running'):rollback(root)
                resume.assert_not_called()

    def test_rollback_resumes_cleanup_after_proxy_switch_without_restarting_old(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);old=root/'previous.json';old.write_text('{}')
            state={'stage':'rollback_draining_current','shared':tmp,
                   'previous_compose':str(old),'caddy_rollback_sha256':'old',
                   'active_registry':str(root/'active.json')}
            (root/'deployment.json').write_text(json.dumps(state))
            with patch('deploy.sha',return_value='old'),patch('deploy.run') as run, \
                 patch('deploy.stop_stack') as stop,patch('deploy.resume_dispatch'):
                result=rollback(root)
                run.assert_not_called();stop.assert_called_once_with(root/'compose.json')
                self.assertEqual(result['stage'],'rolled_back')


if __name__=='__main__':unittest.main()
