"""Exercise migration, changed rows and crash recovery against real PostgreSQL."""
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

import psycopg
from psycopg.types.json import Jsonb
import postgres_migrate as migration
import postgres_publish as publication

@unittest.skipUnless(os.environ.get('TEST_POSTGRES_DSN'),'A disposable PostgreSQL DB is required')
class PostgresPublication(unittest.TestCase):
    def test_full_values_changed_rows_and_interrupted_marker_recovery(self):
        settings=psycopg.conninfo.conninfo_to_dict(os.environ['TEST_POSTGRES_DSN'])
        with tempfile.TemporaryDirectory() as tmp,psycopg.connect(**settings) as pg:
            root=Path(tmp);inputs=root/'inputs';inputs.mkdir();state=root/'state';state.mkdir();work=root/'publication';work.mkdir()
            paths={k:inputs/(k+'.sqlite3') for k in ['catalog','topics','keyword']}
            pg.execute('DROP TABLE IF EXISTS datasets,topics,sources,publications CASCADE')
            if not pg.execute("SELECT 1 FROM pg_roles WHERE rolname='wanted_reader'").fetchone():pg.execute('CREATE ROLE wanted_reader')
            pg.execute(Path(migration.__file__).with_name('postgres.sql').read_text());pg.commit()
            with closing(sqlite3.connect(paths['catalog'])) as db,db:
                db.executescript('CREATE TABLE sources(id TEXT,info TEXT,last_sync TEXT,last_error TEXT);CREATE TABLE datasets(id TEXT PRIMARY KEY,source_id TEXT,title TEXT,description TEXT,metadata TEXT,mappings TEXT,fingerprint TEXT,checked_at TEXT);')
                db.execute("INSERT INTO sources VALUES('s','{}',NULL,'')")
                for n in range(3):
                    meta={'id':str(n),'source_id':'s','title':'서울 '+str(n),'description':'Original','url':'https://example.org/'+str(n)}
                    db.execute('INSERT INTO datasets VALUES(?,?,?,?,?,?,?,?)',(str(n),'s',meta['title'],'Original',json.dumps(meta),'[]',str(n),None))
            with closing(sqlite3.connect(paths['topics'])) as db,db:
                db.executescript('''CREATE TABLE topics(id TEXT,main_id TEXT,main_name TEXT,name TEXT,definition TEXT);
                CREATE TABLE records(id TEXT PRIMARY KEY,band TEXT,score REAL,source TEXT,title TEXT);
                CREATE TABLE links(dataset_id TEXT,topic TEXT,band TEXT,score REAL,alpha REAL);
                CREATE TABLE primary_links(dataset_id TEXT,topic TEXT,band TEXT,score REAL,alpha REAL);
                CREATE TABLE classification_holds(dataset_id TEXT,original_band TEXT,original_score REAL,excluded_links INTEGER);
                CREATE TABLE membership_corrections(dataset_id TEXT,topic TEXT,original_link TEXT,reason TEXT,evidence_url TEXT);''')
                db.execute("INSERT INTO topics VALUES('M01-S01','M01','메인','인구','Definition')")
                for n in range(3):
                    db.execute('INSERT INTO records VALUES(?,?,?,?,?)',(str(n),'high',.5,'s','서울 '+str(n)))
                    for table in ['links','primary_links']:db.execute('INSERT INTO '+table+' VALUES(?,?,?,?,?)',(str(n),'M01-S01','high',.5,.8))
            with closing(sqlite3.connect(paths['keyword'])) as db,db:
                db.execute('CREATE TABLE reference_years(n INTEGER,year INTEGER)');db.executemany('INSERT INTO reference_years VALUES(?,?)',[(n+1,2026) for n in range(3)])
            signature=migration.identity(paths);version=hashlib.sha256(migration.canonical(signature).encode()).hexdigest()[:24]
            with migration.source(paths) as db:
                pg.execute("INSERT INTO sources VALUES('s','{}',NULL,'')");pg.execute("INSERT INTO topics VALUES('M01-S01','M01','메인','인구','Definition')")
                rows=list(migration.records(db));original=migration.canonical(rows)
                with pg.cursor().copy('COPY datasets ('+','.join(migration.FIELDS)+') FROM STDIN') as copy:
                    for row in rows:copy.write_row(tuple(Jsonb(v) if i in migration.JSON_FIELDS else v for i,v in enumerate(row)))
                details={'artifacts':signature,'verification':migration.verify(pg,db,{})};migration.save(pg,version,'active',details);pg.commit()
            from discovery_harness.postgres_catalog import PostgresCatalog
            from psycopg.rows import dict_row
            reader=object.__new__(PostgresCatalog);reader.check=lambda:None
            with psycopg.connect(**settings,autocommit=True,row_factory=dict_row) as read:
                reader.connect=lambda:read
                self.assertEqual(reader.page_ids({'source':'s','year':'2026','band':'high'},1),[(2,'1'),(3,'2')])
                self.assertEqual(reader.page_ids({'year':'2025'},0),[])
                self.assertEqual(reader.page_ids({'concept':'M01'},0),[(1,'0'),(2,'1'),(3,'2')])
                self.assertEqual(reader.page_ids({'concept':'M01-S01','source':'s'},1),[(2,'1'),(3,'2')])
            (state/'admin.json').write_text(json.dumps(settings));(state/'publication.json').write_text(json.dumps({'publication':version}))
            with closing(sqlite3.connect(work/'delta.sqlite3')) as db,db:
                db.execute('CREATE TABLE changes(dataset_id TEXT PRIMARY KEY)');db.executemany('INSERT INTO changes VALUES(?)',[(str(n),) for n in range(4)])
            # The public entry point takes a topics directory; fixtures use the same layout.
            topics=inputs/'topics';topics.mkdir();paths['topics'].replace(topics/'confidence.sqlite3');paths['topics']=topics/'confidence.sqlite3'
            base={**paths,'topics':topics}
            original_files={k:p.read_bytes() for k,p in paths.items()}
            with patch.object(publication,'ROOT',state),patch.object(publication.os,'chown'):
                publication.capture(work)
                with self.assertRaises(FileNotFoundError):publication.apply(work,base)
                (work/'maintenance.json').write_text('{"closed_at":1}')
                with closing(sqlite3.connect(paths['catalog'])) as db,db:
                    db.execute("UPDATE datasets SET title='Updated',metadata=json_set(metadata,'$.title','Updated') WHERE id='0'")
                    db.execute("DELETE FROM datasets WHERE id='1'")
                    db.execute("INSERT INTO datasets SELECT '3',source_id,'New',description,json_set(metadata,'$.id','3','$.title','New'),mappings,'3',checked_at FROM datasets WHERE id='2'")
                with closing(sqlite3.connect(paths['topics'])) as db,db:
                    for table in ['links','primary_links']:db.execute('DELETE FROM '+table+" WHERE dataset_id='1'")
                    db.execute("DELETE FROM records WHERE id='1'");db.execute("INSERT INTO records VALUES('3','unclassified',.1,'s','New')")
                    db.execute("INSERT INTO classification_holds VALUES('3','high',.7,2)")
                real_atomic=publication.atomic
                def interrupt(path,value):
                    if Path(path)==state/'publication.json':raise RuntimeError('Injected crash after commit')
                    real_atomic(path,value)
                with patch.object(publication,'atomic',side_effect=interrupt):
                    with self.assertRaisesRegex(RuntimeError,'Injected crash'):publication.apply(work,base)
                publication.apply(work,base)
                with migration.source(paths) as db:self.assertTrue(migration.verify(pg,db,{})['all_values_equal'])
                self.assertEqual(pg.execute('SELECT count(*) FROM datasets').fetchone()[0],3)
                for k,p in paths.items():p.write_bytes(original_files[k])
                publication.apply(work,base,rollback=True)
                stored=pg.execute('SELECT '+','.join(migration.FIELDS)+' FROM datasets ORDER BY ordinal').fetchall()
                self.assertEqual(migration.canonical(stored),original)
                self.assertTrue(json.loads((work/'postgres-rollback.json').read_text())['all_values_equal'])

if __name__=='__main__':unittest.main()
