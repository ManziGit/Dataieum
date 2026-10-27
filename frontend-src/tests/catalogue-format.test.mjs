import assert from 'node:assert/strict';
import {sourceGroups,yearGroups,yearLabel} from '../src/catalogue-format.ts';

// Card years: a range, a single year (the list API sends it as a string), or nothing.
assert.equal(yearLabel({reference_years:[2024,2014,2019]}),'2014–2024');
assert.equal(yearLabel({reference_year:'1904',reference_years:[1904]}),'1904');
assert.equal(yearLabel({reference_year:null,reference_years:[]}),'');

// Future years move to their own group; nothing is dropped.
const years=yearGroups({'2031':516,'2026':122848,'2027':7218,'2025':196409,'unknown':3},2026);
assert.deepEqual(years.past.map(y=>y.year),['2026','2025']);
assert.deepEqual(years.future.map(y=>y.year),['2027','2031']);

// Every source lands in exactly one group, domestic first.
const sources=[{id:'us',name:'Data.gov',country:'미국'},{id:'kr',name:'공공데이터포털',country:'대한민국'},{id:'wb',name:'World Bank',country:'국제기구'},
  {id:'eu',name:'Eurostat',country:'EU'},{id:'x',name:'Unknown portal'}];
const groups=sourceGroups(sources,s=>s.name,'ko');
assert.deepEqual(groups.map(g=>g.label),['국내','해외 정부','국제기구·EU']);
assert.equal(groups.flatMap(g=>g.sources).length,sources.length);
assert.deepEqual(groups[1].sources.map(s=>s.id),['us','x']);
console.log('Catalogue formatting passed.');
