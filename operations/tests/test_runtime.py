import asyncio
from contextlib import contextmanager, closing
import json
from pathlib import Path
import sqlite3
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from discovery_harness.chat_jobs import ChatJobs
from discovery_harness.host_telemetry import LinuxHostTelemetry, _HostReading
from discovery_harness.native_catalog import NativeCatalog
from discovery_harness.telemetry import TelemetryUnavailable
from discovery_harness.chat import ChatBridge
from discovery_harness.capacity import CapacityController,ServerOverloaded
from discovery_harness.dataieum import DataieumApp


class CPUAccounting(unittest.TestCase):
    def sample(self, delta):
        clock = [10.]
        telemetry = LinuxHostTelemetry(clock=lambda:clock[0])
        def reading(at, ticks):
            return _HostReading(at, ('host',), ticks, 2, 1024, 8192, 1000, 150000)
        with patch.object(telemetry, '_parse', side_effect=[reading(10., (0,)*8), reading(11., delta)]):
            with self.assertRaises(TelemetryUnavailable):telemetry.evaluate('', '', None, sampled_at=10.)
            clock[0] = 11.
            return telemetry.evaluate('', '', None, sampled_at=11.)

    def test_io_wait_does_not_masquerade_as_busy_cpu(self):
        self.assertAlmostEqual(self.sample((10,0,0,10,80,0,0,0)).cpu_fraction,.1)

    def test_real_busy_and_stolen_cpu_remain_pressure(self):
        self.assertAlmostEqual(self.sample((70,0,10,10,0,0,0,10)).cpu_fraction,.9)

    def test_continuation_relaxes_only_cpu_not_memory_or_disk(self):
        c=CapacityController.__new__(CapacityController);c._fatal=False;c._snapshot=None
        def cpu():raise ServerOverloaded('cpu_pressure')
        c.check=cpu;c._recovering_pressures={'cpu_pressure'};c._pressures=lambda sample:[]
        c.check_response()
        c._recovering_pressures.add('memory_pressure')
        with self.assertRaises(ServerOverloaded):c.check_response()
        c._recovering_pressures={'cpu_pressure','disk_pressure'}
        with self.assertRaises(ServerOverloaded):c.check_response()


class AdmittedQuery(unittest.IsolatedAsyncioTestCase):
    async def test_preparation_checks_admission_then_finishes_with_response_limits(self):
        app=DataieumApp.__new__(DataieumApp);app._db_lock=asyncio.Lock()
        app.ready=False;app.prepare_timeout=180;seen=[]
        full_check=lambda:seen.append('admission')
        response_check=lambda:None
        app.harness=SimpleNamespace(active_requests=0,
            capacity=SimpleNamespace(check=full_check,check_response=response_check))
        async def call(operation,*,timeout,check):
            self.assertEqual((operation,timeout),('prepare',180))
            self.assertIs(check,response_check);seen.append('prepare')
        app.worker=SimpleNamespace(busy=False,alive=True,call=call)
        async def end_cycle(_):raise asyncio.CancelledError
        with patch('discovery_harness.dataieum.asyncio.sleep',side_effect=end_cycle):
            with self.assertRaises(asyncio.CancelledError):await app._maintain()
        self.assertTrue(app.ready);self.assertEqual(seen,['admission','prepare'])

    async def test_sql_continuation_uses_bounded_response_check(self):
        app=DataieumApp.__new__(DataieumApp);app._db_lock=asyncio.Lock();app._db_maintenance=False
        app._db_queue_timeout=.5;app._db_waiters=0
        response_check=lambda:None
        app.harness=SimpleNamespace(policy=SimpleNamespace(server=SimpleNamespace(db_timeout_seconds=8)),
                                    capacity=SimpleNamespace(check_response=response_check))
        async def call(operation,query,*,timeout,check):
            self.assertIs(check,response_check);self.assertEqual(timeout,8);return {'ok':True}
        app.worker=SimpleNamespace(call=call)
        async def database(fn):return await fn()
        session=SimpleNamespace(remaining_seconds=8,database=database)
        self.assertEqual(await app._database_query(session,'catalog',{'q':'population'}),{'ok':True})
        self.assertFalse(app._db_lock.locked())


class KeywordPages(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(':memory:')
        self.db.executescript('''
            CREATE TABLE records(id TEXT PRIMARY KEY,source TEXT);
            CREATE TABLE primary_links(dataset_id TEXT PRIMARY KEY,score REAL,topic TEXT);
            CREATE TABLE topics(id TEXT PRIMARY KEY,main_id TEXT);
            INSERT INTO topics VALUES('M01-S01','M01');
            INSERT INTO topics VALUES('M02-S01','M02');
            ATTACH DATABASE ':memory:' AS keyword;
            CREATE TABLE keyword.documents(n INTEGER PRIMARY KEY,id TEXT UNIQUE);
            CREATE VIRTUAL TABLE keyword.phrases USING fts5(text,tokenize='trigram case_sensitive 1');
            CREATE VIRTUAL TABLE keyword.terms USING fts5(text);
        ''')
        for n in range(67):
            ident=f'dataset-{n:03d}'
            self.db.execute('INSERT INTO keyword.documents VALUES(?,?)',(n+1,ident))
            self.db.execute('INSERT INTO keyword.phrases(rowid,text) VALUES(?,?)',(n+1,'population'))
            if n != 5:  # A stale index entry must not be counted as a live dataset.
                self.db.execute('INSERT INTO records VALUES(?,?)',(ident,'a' if n%2 else 'b'))
                self.db.execute('INSERT INTO primary_links VALUES(?,?,?)',(ident,n/100,'M01-S01'))
        self.native=NativeCatalog.__new__(NativeCatalog)
        @contextmanager
        def connection():yield self.db
        self.native.connection=connection
        self.native.module=SimpleNamespace(
            where=lambda q:(' WHERE r.source=?',[q['source']]) if q.get('source') else ('',[]),
            base_catalog=lambda:{}, records=lambda db,ids:[{'id':i} for i in ids])
        self.native._prepare_keyword_membership()

    def tearDown(self):self.db.close()

    def test_exact_count_and_clamped_last_page(self):
        got=self.native._keyword_snapshot({'q':'population','page':'99999999'})
        self.assertEqual((got['total'],got['page'],got['pages']),(66,3,3))
        self.assertEqual(len(got['datasets']),6)
        self.assertNotIn('dataset-005',[d['id'] for d in got['datasets']])

    def test_filters_and_subtopic_relevance_order(self):
        got=self.native._keyword_snapshot({'q':'population','source':'b','concept':'M01-S01'})
        self.assertEqual(got['total'],34)
        self.assertEqual(got['datasets'][0]['id'],'dataset-066')
        self.assertEqual(len(got['datasets']),30)

    def test_empty_results_are_a_valid_page(self):
        got=self.native._keyword_snapshot({'q':'no-matches'})
        self.assertEqual((got['total'],got['page'],got['pages'],got['datasets']),(0,1,1,[]))

    def test_topic_intersection_uses_only_that_topic(self):
        self.db.execute("UPDATE primary_links SET topic='M02-S01' WHERE dataset_id='dataset-066'")
        got=self.native._keyword_snapshot({'q':'population','concept':'M01-S01'})
        self.assertEqual(got['total'],65)
        self.assertEqual(got['datasets'][0]['id'],'dataset-065')
        main=self.native._keyword_snapshot({'q':'population','concept':'M02'})
        self.assertEqual((main['total'],main['datasets']),(1,[{'id':'dataset-066'}]))

    def test_year_options_exclude_hidden_records_and_match_fallback(self):
        self.db.execute('CREATE TABLE keyword.reference_years(year INTEGER,n INTEGER,PRIMARY KEY(year,n))')
        self.db.executemany('INSERT INTO keyword.reference_years VALUES(?,?)',[(2023,1),(2023,6),(2020,6),(1999,2)])
        overview={'summary':{'year_counts':{'1700':999}}}
        self.native.module.base_catalog=lambda:overview
        self.native._prepare_reference_year_counts()
        self.assertEqual(overview['summary']['year_counts'],{'2023':1,'1999':1})
        self.native._keyword_excluded=None
        self.native._prepare_reference_year_counts()
        self.assertEqual(overview['summary']['year_counts'],{'2023':1,'1999':1})

    def test_exact_membership_fast_path_and_fallback_agree(self):
        fast=self.native._keyword_snapshot({'q':'population','page':'2'})
        self.native._keyword_excluded=None
        self.assertEqual(self.native._keyword_snapshot({'q':'population','page':'2'}),fast)

    def test_fts_query_syntax_is_literal(self):
        got=self.native._keyword_snapshot({'q':'population" OR anything'})
        self.assertEqual(got['total'],0)


class ReferenceYears(unittest.TestCase):
    def test_period_precedence_range_and_fallbacks(self):
        from discovery_harness.reference_years import replace
        with sqlite3.connect(':memory:') as db:
            db.execute('CREATE TABLE reference_years(year INTEGER,n INTEGER,PRIMARY KEY(year,n))')
            cases=[({'period':'2020–2022'},'2025','1999',[2020,2021,2022]),
                   ({'period':'unknown'},'2020 / 2022','1999',[2020,2022]),
                   ({},'Population','1999 and 2001',[1999,2001]),
                   ({'source_modified':'2024'},'Population','',[])]
            for n,(metadata,title,description,expected) in enumerate(cases):
                row={'metadata':json.dumps(metadata),'title':title,'description':description}
                replace(db,n,row)
                self.assertEqual([r[0] for r in db.execute('SELECT year FROM reference_years WHERE n=? ORDER BY year',(n,))],expected)
            replace(db,0,None)
            self.assertFalse(db.execute('SELECT 1 FROM reference_years WHERE n=0').fetchone())


class HTTPContinuation(unittest.IsolatedAsyncioTestCase):
    async def response(self, pressure, *, before=False):
        from discovery_harness.asgi import CapacityMiddleware
        state={'reason':pressure if before else None}
        def check():
            if state['reason']:raise ServerOverloaded(state['reason'])
        def check_response():
            if state['reason'] not in {None,'cpu_pressure'}:raise ServerOverloaded(state['reason'])
        session=SimpleNamespace(_check=lambda:None,_reserve=lambda **kw:None)
        async def run(fn):return await fn(session)
        harness=SimpleNamespace(run=run,capacity=SimpleNamespace(check=check,check_response=check_response,record_rejection=lambda reason:None),
            policy=SimpleNamespace(server=SimpleNamespace(enabled=True,max_request_body_bytes=1024,max_response_bytes=1024)))
        async def app(scope,receive,send):
            state['reason']=pressure
            await send({'type':'http.response.start','status':200,'headers':[]})
            await send({'type':'http.response.body','body':b'{}'})
        async def receive():return {'type':'http.request','body':b'','more_body':False}
        messages=[]
        async def send(message):messages.append(message)
        await CapacityMiddleware(app,harness)({'type':'http','path':'/api/catalog','method':'GET'},receive,send)
        return messages

    async def test_completed_response_survives_cpu_pressure(self):
        messages=await self.response('cpu_pressure')
        self.assertEqual((messages[0]['status'],messages[1]['body']),(200,b'{}'))

    async def test_response_still_rejects_memory_and_disk_pressure(self):
        for reason in ['memory_pressure','disk_pressure']:
            self.assertEqual((await self.response(reason))[0]['status'],503)

    async def test_cpu_pressure_still_blocks_new_work(self):
        self.assertEqual((await self.response('cpu_pressure',before=True))[0]['status'],503)


class InternalEndpoints(unittest.TestCase):
    def test_only_fixed_internal_gateway_name_is_accepted(self):
        self.assertEqual(ChatBridge('http://luna:8092').host,'luna')
        for url in ['http://example.com:8092','http://luna.evil:8092','http://user@luna:8092','http://luna/a']:
            with self.assertRaises(ValueError):ChatBridge(url)


class SharedJobs(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
        self.jobs=[];self.calls=[];self.first_started=asyncio.Event();self.finish=asyncio.Event()
        async def handler(value):
            self.calls.append(value['n'])
            if value['n']==1:
                self.first_started.set();await self.finish.wait()
            return {'n':value['n']}
        self.handler=handler

    async def asyncTearDown(self):
        self.finish.set()
        for job in self.jobs:await job.aclose()
        self.temp.cleanup()

    async def create(self):
        job=ChatJobs(self.root/'jobs.sqlite3',self.handler,workers=1,
            dispatcher_lock=self.root/'dispatcher.lock',dispatch_pause=self.root/'pause')
        self.jobs.append(job);await job.start();return job

    async def wait_status(self, job, ident, token, expected):
        async with asyncio.timeout(6):
            while True:
                result=await job.get(ident,token)
                if result['status']==expected:return result
                await asyncio.sleep(.03)

    async def test_handover_preserves_running_and_queued_jobs_without_duplicates(self):
        first=await self.create();a=await first.submit({'n':1},'owner','a'*64)
        await asyncio.wait_for(self.first_started.wait(),3)
        second=await self.create()
        self.assertEqual((await second.get(a['job_id'],'a'*64))['status'],'running')
        b=await second.submit({'n':2},'owner','b'*64)
        self.assertEqual((await first.submit({'n':2},'owner','b'*64))['job_id'],b['job_id'])
        (self.root/'pause').touch();self.finish.set()
        await self.wait_status(second,a['job_id'],'a'*64,'completed')
        async with asyncio.timeout(3):
            while first._dispatcher_fd is not None:await asyncio.sleep(.03)
        self.assertEqual((await second.get(b['job_id'],'b'*64))['status'],'queued')
        await first.aclose();(self.root/'pause').unlink()
        await self.wait_status(second,b['job_id'],'b'*64,'completed')
        self.assertEqual(self.calls,[1,2])

    async def test_other_instance_can_cancel_the_current_dispatcher_job(self):
        first=await self.create();a=await first.submit({'n':1},'owner','a'*64)
        await asyncio.wait_for(self.first_started.wait(),3);second=await self.create()
        await second.cancel(a['job_id'],'a'*64)
        await self.wait_status(second,a['job_id'],'a'*64,'cancelled')
        self.assertEqual(self.calls,[1])

    async def test_legacy_claim_barrier_keeps_new_jobs_queued(self):
        (self.root/'pause').touch();new=await self.create()
        self.assertTrue(new.healthy)
        a=await new.submit({'n':2},'owner','a'*64)
        with closing(sqlite3.connect(self.root/'jobs.sqlite3')) as db,db:
            db.executescript("CREATE TRIGGER migration_claim_barrier BEFORE UPDATE OF status ON chat_jobs "
                "WHEN OLD.status='queued' AND NEW.status='running' BEGIN SELECT RAISE(ABORT,'dispatcher_handover'); END;")
            with self.assertRaises(sqlite3.IntegrityError):
                db.execute("UPDATE chat_jobs SET status='running' WHERE status='queued'")
            db.execute('DROP TRIGGER migration_claim_barrier')
        self.assertEqual((await new.get(a['job_id'],'a'*64))['status'],'queued')
        (self.root/'pause').unlink();await self.wait_status(new,a['job_id'],'a'*64,'completed')
        self.assertEqual(self.calls,[2])

    async def test_permission_error_is_detected_before_standby_reports_ready(self):
        (self.root/'pause').touch()
        job=ChatJobs(self.root/'jobs.sqlite3',self.handler,workers=1,
            dispatcher_lock=self.root/'dispatcher.lock',dispatch_pause=self.root/'pause')
        self.jobs.append(job)
        original=Path.open
        def fail_lock(path,*args,**kwargs):
            if path.name=='dispatcher.lock':raise PermissionError('lock owned by deployment user')
            return original(path,*args,**kwargs)
        with patch.object(Path,'open',fail_lock):
            with self.assertRaises(PermissionError):await job.start()
        self.assertFalse(job.healthy)

    async def test_fatal_dispatcher_cannot_report_healthy(self):
        job=await self.create();self.assertTrue(job.healthy)
        job._fatal=True
        self.assertFalse(job.healthy)


if __name__=='__main__':unittest.main()
