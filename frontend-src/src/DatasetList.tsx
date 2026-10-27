import {useCallback,useEffect,useRef,useState} from 'react';
import {api,safeURL} from './api';
import type {Dataset,Filters,Page,Source,Topic} from './types';
import {i18n,t,useLocale} from './locale';
import {useIntros,type Intro} from './intros';
import {Icon} from './icons';
import {yearLabel} from './catalogue-format';

export function DatasetCard({record,sources,topics,onSelect,onCompare,selected,intro}:{record:Dataset;sources:Source[];topics:Topic[];onSelect:(d:Dataset)=>void;onCompare:(d:Dataset)=>void;selected:boolean;intro?:Intro}) {
  const locale=useLocale(),source=sources.find(s=>s.id===record.source_id),year=yearLabel(record);
  const title=intro?.available?intro[locale].title:i18n.field('dataset',record.id,'title',record.title).text;
  const concepts=(record.mappings||[]).filter(m=>m.status!=='rejected').map(m=>m.concept_id);
  const first=concepts.length?i18n.topic(concepts[0],topics.find(c=>c.id===concepts[0])?.name||concepts[0]):'';
  return <article className="dataset-intro-card">
    <button className="dataset-card" onClick={()=>onSelect(record)} title={record.title}><div className="card-top"><span>{source?.name||record.source_id}</span>{year&&<span className="card-year">{year}</span>}</div><h3>{title}</h3><p>{intro?.brief?intro[locale].summary:record.description}</p>
      {first&&<span className="card-chips"><span className="concept-chip">{first}</span>{concepts.length>1&&<span className="concept-chip more">+{concepts.length-1}</span>}</span>}</button>
    <button className="compare-select" aria-pressed={selected} onClick={()=>onCompare(record)}><Icon name={selected?'check':'compare'} size={15}/><span>{t(selected?'비교에서 제외':'비교에 추가')}</span></button>
  </article>;
}
const PAGE=30,HEIGHT=240,MAX_PAGES=12;
type WindowState={controller:AbortController;pages:Map<number,Dataset[]>;cursors:Map<number,string>;busy:boolean;end:number;done:boolean;publication?:string};
const fresh=():WindowState=>({controller:new AbortController(),pages:new Map(),cursors:new Map([[0,'']]),busy:false,end:0,done:false});
export function DatasetList({filters,sources,topics,onSelect,onCompare,selected}:{filters:Filters;sources:Source[];topics:Topic[];onSelect:(d:Dataset)=>void;onCompare:(d:Dataset)=>void;selected:Dataset[]}) {
  useLocale();
  const rawKey=new URLSearchParams(Object.entries(filters).filter(([,v])=>v)).toString();
  const [key,setKey]=useState(rawKey),[revision,changed]=useState(0),[count,setCount]=useState<number|null>(null),[error,setError]=useState('');
  const [viewport,setViewport]=useState({top:0,height:600,width:600});
  const state=useRef<WindowState>(fresh()),scroller=useRef<HTMLDivElement>(null),position=useRef(0);
  useEffect(()=>{const timer=setTimeout(()=>setKey(rawKey),250);return()=>clearTimeout(timer);},[rawKey]);
  const load=useCallback(async(page:number)=>{
    const current=state.current,cursor=current.cursors.get(page);
    if(current.busy||current.pages.has(page)||cursor===undefined||current.controller.signal.aborted)return;
    current.busy=true;changed(v=>v+1);setError('');
    try {
      const query=new URLSearchParams(key);if(cursor)query.set('cursor',cursor);
      const result=await api<Page>('/api/catalog/page?'+query,{signal:current.controller.signal});
      if(state.current!==current)return;
      if(!Array.isArray(result.datasets)||result.datasets.length>PAGE||new Set(result.datasets.map(d=>d.id)).size!==result.datasets.length||typeof result.has_more!=='boolean'||!(result.next_cursor===null||typeof result.next_cursor==='string')||(result.has_more&&(!result.next_cursor||result.datasets.length!==PAGE)))throw new Error('목록 응답이 올바르지 않습니다.');
      if(current.publication&&current.publication!==result.publication)throw new Error('자료가 갱신됐어요. 검색을 다시 실행해 주세요.');
      current.publication=result.publication;current.pages.set(page,result.datasets);
      current.end=Math.max(current.end,page*PAGE+result.datasets.length);
      if(result.next_cursor)current.cursors.set(page+1,result.next_cursor);
      else current.done=true;
      // Keep only twelve pages of metadata. Cursor positions permit exact reads
      // when scrolling back; they never require retaining every dataset object.
      while(current.pages.size>MAX_PAGES){
        const farthest=[...current.pages.keys()].sort((a,b)=>Math.abs(b-position.current)-Math.abs(a-position.current))[0];
        current.pages.delete(farthest);
      }
      if(page===0)void api<{total:number;publication:string}>('/api/catalog/count?'+key,{signal:current.controller.signal}).then(value=>{
        if(state.current===current&&value.publication===result.publication&&Number.isSafeInteger(value.total))setCount(value.total);
      }).catch(()=>{});
    } catch(e) {if(!current.controller.signal.aborted&&state.current===current)setError(e instanceof Error?e.message:String(e));}
    finally {current.busy=false;if(state.current===current)changed(v=>v+1);}
  },[key]);
  useEffect(()=>{
    state.current.controller.abort();state.current=fresh();setCount(null);setError('');changed(v=>v+1);
    if(scroller.current)scroller.current.scrollTop=0;
    void load(0);return()=>state.current.controller.abort();
  },[load]);
  useEffect(()=>{
    const host=scroller.current!;let frame=0;
    const measure=()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(()=>setViewport({top:host.scrollTop,height:host.clientHeight,width:host.clientWidth-30}));};
    const resize=new ResizeObserver(measure);resize.observe(host);host.addEventListener('scroll',measure,{passive:true});measure();
    return()=>{cancelAnimationFrame(frame);resize.disconnect();host.removeEventListener('scroll',measure);};
  },[]);
  const columns=Math.max(1,Math.floor((viewport.width+14)/280));
  const start=Math.max(0,Math.floor(Math.max(0,viewport.top-45)/HEIGHT)-1)*columns;
  const end=Math.min(state.current.end,(Math.ceil((viewport.top+viewport.height)/HEIGHT)+2)*columns);
  position.current=Math.floor(start/PAGE);
  const visible:Dataset[]=[];
  for(let i=start;i<end;i++){const record=state.current.pages.get(Math.floor(i/PAGE))?.[i%PAGE];if(record)visible.push(record);}
  const intros=useIntros(visible);
  useEffect(()=>{
    if(error||rawKey!==key||state.current.busy)return;
    for(let p=Math.floor(start/PAGE);p<=Math.floor(Math.max(start,end-1)/PAGE);p++){
      if(state.current.cursors.has(p)&&!state.current.pages.has(p)){void load(p);return;}
    }
    if(!state.current.done&&end>=state.current.end-columns*2)void load(Math.floor(state.current.end/PAGE));
  },[start,end,columns,revision,load,error,key,rawKey]);
  return <div className="result-scroll" ref={scroller} aria-busy={state.current.busy||key!==rawKey}>
    <h2 className="sr-only">{t('자료 목록')}</h2>
    <p className="results-total" role="status">{!state.current.publication?'':count===null?`${i18n.number(state.current.end)}${t('건')}`:`${i18n.number(state.current.end)} / ${i18n.number(count)}`}</p>
    <div className="virtual-results" style={{height:Math.ceil(state.current.end/columns)*HEIGHT}}>
      {Array.from({length:Math.max(0,end-start)},(_,offset)=>{const index=start+offset,record=state.current.pages.get(Math.floor(index/PAGE))?.[index%PAGE];return <div key={index} className="virtual-card" style={{top:Math.floor(index/columns)*HEIGHT,left:`${(index%columns)*100/columns}%`,width:`${100/columns}%`,height:HEIGHT}}>{record?<DatasetCard record={record} intro={intros[record.id]} sources={sources} topics={topics} onSelect={onSelect} onCompare={onCompare} selected={selected.some(d=>d.id===record.id)}/>:<div className="card-placeholder">{t('불러오는 중')}</div>}</div>;})}
    </div>
    {!state.current.busy&&!state.current.end&&!error&&<p className="empty">{t('검색 결과 없음')}</p>}
    {error&&<p role="alert">{t(error)} <button onClick={()=>{setError('');changed(v=>v+1);}}>{t('다시 시도')}</button></p>}
    <div className="list-sentinel">{state.current.busy?t('불러오는 중'):!state.current.done?<button onClick={()=>void load(Math.floor(state.current.end/PAGE))}>{t('더 보기')}</button>:null}</div>
  </div>;
}
export function SourceLink({url,children,className}:{url?:string;children:React.ReactNode;className?:string}) {
  const safe=safeURL(url);return safe?<a className={className} href={safe} target="_blank" rel="noopener noreferrer">{children}</a>:null;
}
