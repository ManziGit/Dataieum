import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import sys
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import ci_deploy as ci

REV='a'*40
IMAGES={r:'sha256:'+str(i)*64 for i,r in enumerate(ci.ROLES,1)}

class RestrictedCommands(unittest.TestCase):
    def test_only_exact_deployment_commands_are_allowed(self):
        self.assertEqual(ci.parse_command('load '+REV+' atlas'),['load',REV,'atlas'])
        self.assertEqual(ci.parse_command('status 12'),['status','12'])
        for value in ('whoami','status 0','status ../1','status 1;id','load '+REV+' other',
                      'load '+REV+' atlas && id','submit '+REV+' -1','execute 1',''):
            with self.subTest(value=value),self.assertRaises(ValueError):ci.parse_command(value)

    def test_every_loaded_image_must_match_revision_platform_and_digest(self):
        with patch.object(ci,'inspect',side_effect=lambda tag:{'Id':IMAGES[tag.split('wanted-')[1].split(':')[0]],'Architecture':'amd64','Os':'linux'}):
            ci.identities(REV,IMAGES)
        with patch.object(ci,'inspect',return_value={'Id':IMAGES['atlas'],'Architecture':'arm64','Os':'linux'}):
            with self.assertRaises(ValueError):ci.identities(REV,IMAGES)
        with self.assertRaises(ValueError):ci.identities(REV,{'atlas':IMAGES['atlas']})

    def test_completed_run_is_idempotent_and_cannot_change_identity(self):
        with tempfile.TemporaryDirectory() as tmp,patch.object(ci,'ROOT',Path(tmp)),patch.object(ci,'identities'):
            job=Path(tmp)/'7';job.mkdir()
            manifest={'revision':REV,'run_id':7,'images':IMAGES}
            (job/'manifest.json').write_text(json.dumps(manifest))
            (job/'status.json').write_text('{"stage":"complete"}')
            with patch.object(ci.subprocess,'run') as run:
                self.assertEqual(ci.submit(REV,'7',io.BytesIO(json.dumps(manifest).encode()))['stage'],'complete')
                run.assert_not_called()
            changed={**manifest,'extra':'different'}
            with self.assertRaises(ValueError):ci.submit(REV,'7',io.BytesIO(json.dumps(changed).encode()))

class Recovery(unittest.TestCase):
    def exercise(self,fail_live=False,fail_validation=False,proxy_changed=False):
        with tempfile.TemporaryDirectory() as tmp:
            base=Path(tmp);jobs=base/'jobs';job=jobs/'1';job.mkdir(parents=True)
            releases=base/'releases';releases.mkdir();ops=base/'ops';ops.mkdir()
            refresh=ops/'refresh-images.json'
            original={'services':{'collector':{'image':'old-collector'},'publisher':{'image':'old-vector'}},'publication_enabled':False}
            refresh.write_text(json.dumps(original))
            (job/'manifest.json').write_text(json.dumps({'revision':REV,'run_id':1,'images':IMAGES}))
            (job/'status.json').write_text('{"stage":"queued"}')
            root=releases/('dataieum-'+REV[:12]+'-1');events=[]
            def prepare(root,*args):
                root.mkdir();(root/'deployment.json').write_text(json.dumps({'stage':'prepared','caddy_previous_sha256':'before'}))
                (root/'compose.json').write_text('{}');events.append('prepare')
            def promote(root):
                events.append('promote');d=json.loads((root/'deployment.json').read_text());d['stage']='active'
                (root/'deployment.json').write_text(json.dumps(d));return d
            def rollback(root):
                events.append('rollback');(root/'deployment.json').write_text('{"stage":"rolled_back"}')
            def validate(root):
                events.append('validate')
                if fail_validation:raise RuntimeError('invalid candidate')
            def live(root):
                events.append('live')
                if fail_live:raise RuntimeError('public query failed')
                return [{'status':200}]
            with patch.multiple(ci,ROOT=jobs,OPS=ops,RELEASES=releases,REFRESH=refresh,REGISTRY=base/'active.json'),\
                 patch.object(ci,'locks'),patch.object(ci,'identities'),patch.object(ci,'port',return_value=18101),\
                 patch.object(ci,'install_host_code'),patch.object(ci,'restore_host_code',side_effect=lambda j:events.append('restore-host')),\
                 patch.object(ci,'verify_live',side_effect=live),patch.object(ci.deploy,'maintenance_guard'),\
                 patch.object(ci.deploy,'prepare',side_effect=prepare),patch.object(ci.deploy,'promote',side_effect=promote),\
                 patch.object(ci.deploy,'rollback',side_effect=rollback),patch.object(ci.deploy,'validate',side_effect=validate),\
                 patch.object(ci.deploy,'sha',return_value='changed' if proxy_changed else 'before'),\
                 patch.object(ci.deploy,'run') as run:
                result=ci.execute('1')
                calls=[x.args[0] for x in run.call_args_list]
            return result,events,json.loads(refresh.read_text()),original,calls

    def test_success_updates_images_without_resuming_publication(self):
        result,events,cfg,old,calls=self.exercise()
        self.assertEqual(result['stage'],'complete')
        self.assertFalse(cfg['publication_enabled'])
        self.assertEqual(cfg['services']['collector']['image'],IMAGES['refresh'])
        self.assertEqual(events,['prepare','validate','promote','live'])

    def test_failed_live_check_rolls_back_app_host_code_and_refresh_images(self):
        result,events,cfg,old,calls=self.exercise(fail_live=True)
        self.assertEqual(result['stage'],'rolled_back');self.assertEqual(cfg,old)
        self.assertEqual(events[-2:],['rollback','restore-host'])

    def test_failed_candidate_never_promotes(self):
        result,events,cfg,old,calls=self.exercise(fail_validation=True)
        self.assertEqual(result['stage'],'failed');self.assertNotIn('promote',events)
        self.assertEqual(cfg,old);self.assertTrue(any('down' in c for c in calls))

    def test_uncheckpointed_proxy_change_preserves_both_stacks_for_recovery(self):
        result,events,cfg,old,calls=self.exercise(fail_validation=True,proxy_changed=True)
        self.assertEqual(result['stage'],'recovery_required')
        self.assertFalse(any('down' in c for c in calls))
        self.assertNotIn('restore-host',events)

class LiveProof(unittest.TestCase):
    def test_transient_readiness_requires_subsequent_real_domain_checks(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);(root/'deployment.json').write_text('{"port":18101}')
            def reply(*args,**kwargs):
                r=io.BytesIO(b'{"datasets":[{"id":"real"}]}');r.status=200;return r
            with patch.object(ci.deploy,'request',side_effect=[{'status':503,'ready':False},{'status':200,'ready':True}]),patch.object(ci.time,'sleep'),patch.object(ci.urllib.request,'urlopen',side_effect=reply) as get:
                checks=ci.verify_live(root)
            self.assertEqual(len(checks),2);self.assertEqual(get.call_count,2)
            proof=json.loads((root/'live-check.json').read_text())
            self.assertTrue(proof['passed']);self.assertEqual(len(proof['attempts']),2)
    def test_persistent_failure_remains_failure_with_four_recorded_attempts(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);(root/'deployment.json').write_text('{"port":18101}')
            with patch.object(ci.deploy,'request',return_value={'status':503,'ready':False}),patch.object(ci.time,'sleep'),patch.object(ci.urllib.request,'urlopen') as get:
                with self.assertRaises(RuntimeError):ci.verify_live(root)
                get.assert_not_called()
            proof=json.loads((root/'live-check.json').read_text());self.assertFalse(proof['passed']);self.assertEqual(len(proof['attempts']),4)

if __name__=='__main__':unittest.main()
