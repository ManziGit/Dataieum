import {useEffect,useState} from 'react';
import {api} from './api';
import type {Dataset} from './types';
export type Intro={id:string;available:boolean;brief?:boolean;ko:{title:string;summary:string};en:{title:string;summary:string};region?:{ko:string;en:string}};
const cache=new Map<string,Intro>();
export function useIntros(records:Dataset[]) {
  const key=JSON.stringify(records.map(r=>[r.id,r.title,r.description]));
  const [values,setValues]=useState<Record<string,Intro>>({});
  useEffect(()=>{
    const tuples:string[][]=JSON.parse(key),controller=new AbortController(),result:Record<string,Intro>={};
    const missing=tuples.filter(tuple=>{const row=cache.get(JSON.stringify(tuple));if(row)result[row.id]=row;return !row;});
    setValues(result);
    void (async()=>{
      for(let i=0;i<missing.length;i+=5){
        const batch=missing.slice(i,i+5),ids=batch.map(r=>r[0]);
        if(controller.signal.aborted)return;
        try {
          const query=new URLSearchParams({ids:JSON.stringify(ids)});if(query.toString().length>8192)continue;
          const response=await api<{items:Intro[]}>('/api/dataset-intros?'+query,{signal:controller.signal,headers:{'X-Dataieum-Chat':'1'}});
          if(!Array.isArray(response.items)||response.items.length!==ids.length||new Set(response.items.map(r=>r.id)).size!==ids.length)continue;
          for(const row of response.items){
            const tuple=batch.find(r=>r[0]===row.id);
            if(!tuple||typeof row.available!=='boolean'||!['ko','en'].every(lang=>{const text=row[lang as 'ko'|'en'];return text&&typeof text.title==='string'&&text.title.length<=512&&typeof text.summary==='string'&&text.summary.length<=240;}))continue;
            cache.set(JSON.stringify(tuple),row);result[row.id]=row;
          }
          while(cache.size>200)cache.delete(cache.keys().next().value!);
          if(!controller.signal.aborted)setValues({...result});
        } catch { /* Original metadata stays visible; reads never generate text. */ }
      }
    })();
    return()=>controller.abort();
  },[key]);
  return values;
}
