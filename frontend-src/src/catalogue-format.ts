import type {Dataset,Source} from './types';

// One year, a range for several years, or nothing when the source gives none.
export function yearLabel(record:Pick<Dataset,'reference_year'|'reference_years'>){
  const years=[...new Set((record.reference_years||[]).map(Number).filter(Number.isFinite))].sort((a,b)=>a-b);
  if(years.length>1)return `${years[0]}–${years.at(-1)}`;
  return years.length?String(years[0]):record.reference_year?String(record.reference_year):'';
}

// Years up to the current one come first (newest first); later years are planned or projected data.
export function yearGroups(counts:Record<string,number>,thisYear:number){
  const years=Object.entries(counts).filter(([year])=>/^\d{4}$/.test(year)).map(([year,count])=>({year,count}));
  return {
    past:years.filter(y=>Number(y.year)<=thisYear).sort((a,b)=>Number(b.year)-Number(a.year)),
    future:years.filter(y=>Number(y.year)>thisYear).sort((a,b)=>Number(a.year)-Number(b.year)),
  };
}

const DOMESTIC='대한민국',GLOBAL=['국제기구','EU'];
// Domestic portals, other governments, then international bodies; every source lands in exactly one group.
export function sourceGroups(sources:Source[],name:(source:Source)=>string,locale:string){
  const sorted=[...sources].sort((a,b)=>name(a).localeCompare(name(b),locale));
  return [
    {label:'국내',sources:sorted.filter(s=>s.country===DOMESTIC),showCountry:false},
    {label:'해외 정부',sources:sorted.filter(s=>s.country!==DOMESTIC&&!GLOBAL.includes(s.country||'')),showCountry:true},
    {label:'국제기구·EU',sources:sorted.filter(s=>GLOBAL.includes(s.country||'')),showCountry:false},
  ].filter(group=>group.sources.length);
}
