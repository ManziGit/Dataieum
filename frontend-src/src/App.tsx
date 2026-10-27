import {useCallback,useEffect,useRef,useState} from 'react';
import {api} from './api';
import {i18n,t,useLocale} from './locale';
import {mountGraph,type GraphController,type GraphState} from './canvas-graph';
import {ChatDock,type ChatControl,type GuideState} from './ChatDock';
import {Compare} from './Compare';
import {Collections} from './Collections';
import {Help,guideUnseen} from './Help';
import {Sidebar} from './Sidebar';
import {useIntros} from './intros';
import {DatasetList,SourceLink} from './DatasetList';
import {Icon} from './icons';
import {emptyFilters,type Bootstrap,type Dataset,type Filters,type GraphNode,type Source} from './types';
import {sourceGroups,yearGroups} from './catalogue-format';

type Model=GraphState & {node:GraphNode|null};
const initial:Model={sources:[],concepts:[],filters:{...emptyFilters},view:'explore',mode:'graph',selectedRecord:null,node:null};
export function App() {
  const [graphPhase,setGraphPhase]=useState('ready');
  const [filtersOpen,setFiltersOpen]=useState(false),[guideState,setGuideState]=useState<GuideState>({busy:false,result:null,issue:false,official:0});
  const chatControl=useRef<ChatControl|null>(null);
  const locale=useLocale(),[model,setModel]=useState<Model>(initial),latest=useRef(model);
  const [bootstrap,setBootstrap]=useState<Bootstrap|null>(null),[loading,setLoading]=useState(true),[notice,setNotice]=useState(''),[caption,setCaption]=useState(''),[selection,setSelection]=useState<Dataset[]>([]),[comparing,setComparing]=useState(false),[help,setHelp]=useState(guideUnseen),[collections,setCollections]=useState(false),[retry,setRetry]=useState(0);
  const graph=useRef<GraphController|null>(null),canvas=useRef<HTMLCanvasElement>(null),focus=useRef<HTMLDivElement>(null),search=useRef<HTMLInputElement>(null),detailRequest=useRef<AbortController|null>(null),restoreRequest=useRef<AbortController|null>(null),searchTimer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined);
  const commit=useCallback((fn:(old:Model)=>Model)=>{const value=fn(latest.current);latest.current=value;setModel(value);},[]);
  const select=useCallback((record:Dataset|null)=>{
    detailRequest.current?.abort();commit(old=>({...old,selectedRecord:record}));if(!record)return;
    const controller=new AbortController();detailRequest.current=controller;
    void api<{dataset:Dataset}>('/api/datasets/'+encodeURIComponent(record.id),{signal:controller.signal}).then(result=>{
      if(!controller.signal.aborted&&result.dataset?.id===record.id)commit(old=>old.selectedRecord?.id===record.id?{...old,selectedRecord:result.dataset}:old);
    }).catch(e=>{if(!controller.signal.aborted)setNotice(String(e.message||e));});
  },[commit]);
  const clear=useCallback(()=>{clearTimeout(searchTimer.current);select(null);commit(old=>({...old,filters:{...emptyFilters},node:null}));graph.current?.filtersChanged();},[commit,select]);
  useEffect(()=>{
    const engine=mountGraph({canvas:canvas.current!,focusHost:focus.current!,i18n,getState:()=>latest.current,onSelect:select,onNode:node=>commit(old=>({...old,node,selectedRecord:null})),onTopic:concept=>commit(old=>({...old,filters:{...old.filters,band:'',concept},view:'explore',mode:'graph',node:null,selectedRecord:null})),onReset:clear,onClearFilters:()=>commit(old=>({...old,filters:{...emptyFilters},node:null})),onNotice:setNotice,onLoading:setLoading,onCaption:setCaption});
    graph.current=engine;
    return()=>{engine.destroy();graph.current=null;detailRequest.current?.abort();restoreRequest.current?.abort();clearTimeout(searchTimer.current);};
  },[clear,commit,select]);
  useEffect(()=>{
    const controller=new AbortController();setLoading(true);setNotice('');
    void api<Bootstrap>('/api/bootstrap',{signal:controller.signal}).then(data=>{
      if(!Array.isArray(data.sources)||!Array.isArray(data.concepts)||!data.graph||!data.summary)throw new Error('카탈로그 응답이 올바르지 않습니다.');
      commit(old=>({...old,sources:data.sources,concepts:data.concepts}));setBootstrap(data);graph.current?.bootstrap(data);
    }).catch(e=>{if(!controller.signal.aborted)setNotice(String(e.message||e));}).finally(()=>{if(!controller.signal.aborted)setLoading(false);});
    return()=>controller.abort();
  },[retry,commit]);
  useEffect(()=>{document.body.dataset.view=model.view;document.body.dataset.mode=model.mode;graph.current?.refresh();},[model.view,model.mode]);
  useEffect(()=>{graph.current?.localeChanged();},[locale]);
  useEffect(()=>{
    const key=(event:KeyboardEvent)=>{if(event.key==='/'&&!['INPUT','TEXTAREA','SELECT'].includes((document.activeElement as HTMLElement)?.tagName)){event.preventDefault();commit(old=>({...old,view:'explore'}));search.current?.focus();}};
    document.addEventListener('keydown',key);return()=>document.removeEventListener('keydown',key);
  },[commit]);
  useEffect(()=>{const receive=(event:Event)=>{const phase=(event as CustomEvent).detail?.phase;if(['loading','ready','error'].includes(phase))setGraphPhase(phase);};window.addEventListener('dataieum:graph-status',receive);return()=>window.removeEventListener('dataieum:graph-status',receive);},[]);
  const change=(key:keyof Filters,value:string)=>{
    select(null);commit(old=>({...old,filters:{...old.filters,[key]:value},node:null}));
    clearTimeout(searchTimer.current);
    if(model.mode==='graph'){
      if(key==='q')searchTimer.current=setTimeout(()=>graph.current?.filtersChanged(),300);
      else if(key==='concept'&&value)graph.current?.chooseTopic(value,true);
      else graph.current?.filtersChanged();
    }
  };
  const compare=(record:Dataset)=>{restoreRequest.current?.abort();setSelection(old=>{
    if(old.some(r=>r.id===record.id))return old.filter(r=>r.id!==record.id);
    if(old.length===4){setNotice(t('최대 4개 자료를 비교할 수 있어요.'));return old;}
    return [...old,record];
  });};
  const activeFilters=[model.filters.source,model.filters.concept,model.filters.year].filter(Boolean).length;
  const nodeTopic=model.concepts.find(c=>c.id===model.node?.query?.concept);
  const ds=model.selectedRecord;
  const intro=useIntros(ds?[ds]:[])[ds?.id||''];
  const sourceName=(s:Source)=>i18n.field('source',s.id,'name',s.name).text;
  const years=yearGroups(bootstrap?.summary.year_counts||{},new Date().getFullYear());
  // Placeholder values from the catalogue are gathered into one pointer to the provider page.
  const missing=(value:unknown)=>value==null||['','미상','제공처 확인','unknown','none','n/a','-'].includes(String(value).trim().toLowerCase());
  const day=(value?:string)=>{const date=value?new Date(value):null;return date&&!Number.isNaN(date.getTime())?new Intl.DateTimeFormat(locale==='ko'?'ko-KR':'en-US',{dateStyle:'long'}).format(date):value||'';};
  const sourceFields=[['period','기준 기간'],['format','제공 형식'],['license','이용 조건']] as const;
  const atSource=sourceFields.filter(([key])=>ds&&missing(ds[key])).map(([,label])=>t(label));
  const closePanel=()=>ds?select(null):commit(old=>({...old,node:null}));
  return <>
    <nav className="catalogue-skip" aria-label={t('바로 이동')}><a href="#search">{t('검색으로 이동')}</a><a href="#chat-mode">{t('채팅으로 이동')}</a></nav>
    <Sidebar topics={model.concepts} summary={bootstrap?.summary} selected={model.filters.concept} band={model.filters.band} screen={model.view==='sources'?'sources':model.mode} onTopic={id=>{commit(old=>({...old,view:'explore',mode:'graph'}));graph.current?.chooseTopic(id,true);}} onAll={()=>{commit(old=>({...old,view:'explore',mode:'graph'}));clear();}} onUnclassified={()=>{select(null);commit(old=>({...old,view:'explore',mode:'graph',filters:{...old.filters,concept:'',band:'unclassified'},node:null}));graph.current?.filtersChanged();}} onScreen={screen=>commit(old=>screen==='sources'?{...old,view:'sources'}:{...old,view:'explore',mode:screen})} onHelp={()=>setHelp(true)} onCollections={()=>setCollections(true)}/>
    <main><section className="heading"><h1>{t(model.view==='sources'?'사이트':model.mode==='list'?'목록':'연결 지도')}</h1></section>
      <div id="notice" role="status" aria-live="polite">{t(notice)}{!bootstrap&&!loading&&<button onClick={()=>setRetry(v=>v+1)}>{t('다시 시도')}</button>}</div>
      <section id="explore-view" hidden={model.view!=='explore'}>
        <div className="filters glass" onKeyDown={e=>{if(e.key==='Escape')setFiltersOpen(false);}}><label className="search"><Icon name="search"/><input ref={search} id="search" type="search" value={model.filters.q} maxLength={200} onChange={e=>change('q',e.target.value)} placeholder={t('자료명 검색')} aria-label={t('자료명 검색')}/><kbd>/</kbd></label>
          <button className="catalogue-filter-toggle" aria-expanded={filtersOpen} aria-controls="catalogue-filter-options" onClick={()=>setFiltersOpen(!filtersOpen)}><Icon name="filter" size={16}/><span>{t('필터')}</span>{activeFilters>0&&<span className="filter-badge" aria-hidden="true">{activeFilters}</span>}</button><div className="catalogue-filter-options" id="catalogue-filter-options" data-open={filtersOpen} role="group" aria-label={t('검색 필터')}><label className="catalogue-filter-field"><span>{t('제공 사이트')}</span><select id="source-filter" aria-label={t('제공 사이트')} value={model.filters.source} onChange={e=>change('source',e.target.value)}><option value="">{t('모든 사이트')}</option>{sourceGroups(model.sources,sourceName,locale).map(group=><optgroup key={group.label} label={t(group.label)}>{group.sources.map(s=><option key={s.id} value={s.id}>{sourceName(s)}{group.showCountry&&s.country?` (${t(s.country)})`:''}</option>)}</optgroup>)}</select></label>
          <label className="catalogue-filter-field"><span>{t('개념')}</span><select id="concept-filter" aria-label={t('개념')} value={model.filters.concept} onChange={e=>change('concept',e.target.value)}><option value="">{t('모든 개념')}</option>{model.concepts.map(c=><option key={c.id} value={c.id}>{i18n.topic(c.id,c.name)}</option>)}</select></label>
          <label className="catalogue-filter-field"><span>{t('자료 연도')}</span><select id="year-filter" aria-label={t('자료 연도')} value={model.filters.year} onChange={e=>change('year',e.target.value)}><option value="">{t('모든 연도')}</option>{years.past.length>0&&<optgroup label={t('올해와 지난 연도')}>{years.past.map(({year,count})=><option key={year} value={year}>{year} · {i18n.number(count)}</option>)}</optgroup>}{years.future.length>0&&<optgroup label={t('계획·전망 연도')}>{years.future.map(({year,count})=><option key={year} value={year}>{year} · {i18n.number(count)}</option>)}</optgroup>}</select></label><button id="clear" className="subtle" onClick={clear}>{t('초기화')}</button></div>
        </div>
        {model.mode==='graph'&&graphPhase!=='ready'&&<div className="catalogue-query-status" role="status"><span>{t(graphPhase==='loading'?'조건을 적용하고 있어요. 현재 지도는 이전 결과예요.':'새 조건을 적용하지 못했어요. 현재 지도는 이전 결과예요.')}</span>{graphPhase==='error'&&<button onClick={()=>graph.current?.filtersChanged()}>{t('다시 시도')}</button>}</div>}
        <div className="workspace"><section className="graph-panel">
          <div className="panel-head"><p className="catalogue-intro">{t('필요한 공공데이터의 공식 페이지를 찾아보세요.')}</p><span id="result-count">{model.mode==='graph'&&bootstrap?caption:''}</span></div>
          <div id="graph-wrap" hidden={model.mode!=='graph'}><canvas ref={canvas} id="graph" tabIndex={0} role="group" aria-label={t('자료와 주제 연결 그래프. 휠로 확대, 빈 곳을 끌어 이동, 노드를 끌어 배치합니다.')}/><div id="graph-accessibility" className="graph-accessibility"/><div className="graph-legend"><span>{t('─ 공통 자료')}</span></div><div className="zoom glass"><span id="zoom-value">100%</span><button onClick={()=>graph.current?.zoom(.78)} aria-label={t('확대')} title={t('확대')}><Icon name="plus"/></button><button onClick={()=>graph.current?.zoom(1/.78)} aria-label={t('축소')} title={t('축소')}><Icon name="minus"/></button><button onClick={clear} aria-label={t('지도 위치 초기화')} title={t('지도 위치 초기화')}><Icon name="reset"/></button></div><div ref={focus}/></div>
          {model.mode==='list'&&<div id="dataset-list"><DatasetList filters={model.filters} sources={model.sources} topics={model.concepts} onSelect={select} onCompare={compare} selected={selection}/></div>}
          <div id="load-status" role="status" hidden={!loading}>{t('불러오는 중')}</div>
          <ChatDock graph={graph} control={chatControl} onGuide={setGuideState}/>
        </section>
        {(ds||(model.node&&nodeTopic))&&<div className="panel-scrim" aria-hidden="true" onClick={closePanel}/>}
        <aside id="detail" className="detail glass" hidden={!ds} aria-label={t('선택한 데이터 상세')}>{ds&&<><div className="detail-top"><span className="source-label">{model.sources.find(s=>s.id===ds.source_id)?.name||ds.source_id}</span><button className="close" onClick={()=>select(null)} aria-label={t('상세 닫기')}><Icon name="close"/></button></div><h3>{intro?.available?intro[locale].title:i18n.field('dataset',ds.id,'title',ds.title).text}</h3>{intro?.available&&<details className="metadata-original"><summary>{t('원문 제목')}</summary><p>{ds.title}</p></details>}<p className="description">{ds.description||t('제공된 설명이 없습니다.')}</p>
          <div className="detail-actions"><SourceLink className="action primary" url={ds.url}>{t('원본 제공처로 이동 ↗')}</SourceLink><SourceLink className="action" url={ds.metadata_url}>{t('설명 출처 확인 ↗')}</SourceLink><button className="action compare-select" aria-pressed={selection.some(r=>r.id===ds.id)} onClick={()=>compare(ds)}><Icon name={selection.some(r=>r.id===ds.id)?'check':'compare'} size={16}/><span>{t(selection.some(r=>r.id===ds.id)?'비교에서 제외':'비교에 추가')}</span></button></div>
          <dl className="meta"><div><dt>{t('제공기관')}</dt><dd>{missing(ds.publisher)?t('미상'):ds.publisher}</dd></div><div><dt>{t('지역')}</dt><dd>{intro?.region?.[locale]||(missing(ds.region)?t('미상'):ds.region)}</dd></div>
            {sourceFields.filter(([key])=>!missing(ds[key])).map(([key,label])=><div key={key}><dt>{t(label)}</dt><dd>{String(ds[key])}</dd></div>)}
            {ds.updated_year&&<div><dt>{t('갱신')}</dt><dd>{t('{year}년',{year:ds.updated_year})}</dd></div>}
            {ds.checked_at&&<div><dt>{t('설명 확인')}</dt><dd>{day(ds.checked_at)}</dd></div>}</dl>
          {atSource.length>0&&<p className="meta-hint"><span>{t('{fields}은 제공처 페이지에서 확인하세요.',{fields:(locale==='en'?atSource.map(s=>s.toLowerCase()):atSource).join(', ')})}</span><SourceLink url={ds.url}>{t('제공처 열기 ↗')}</SourceLink></p>}
          <h4>{t('연결된 개념')}<span className="concept-auto">· {t('자동 분류')}</span></h4><ul className="concept-chips">{(ds.mappings||[]).filter(m=>m.status!=='rejected').map(m=><li key={m.concept_id}>{i18n.topic(m.concept_id,model.concepts.find(c=>c.id===m.concept_id)?.name||m.concept_id)}</li>)}</ul>
          <p className="concept-note">{t('자료 제목과 설명을 바탕으로 자동으로 분류했어요. 실제 내용과 다를 수 있어요.')}</p></>}</aside>
        {model.node&&nodeTopic&&!ds&&<aside className="catalogue-node-panel glass"><header><h2>{i18n.topic(nodeTopic.id,nodeTopic.name)}</h2><button className="close" onClick={()=>commit(old=>({...old,node:null}))} aria-label={t('닫기')}><Icon name="close"/></button></header><p>{i18n.topic(nodeTopic.id,nodeTopic.definition||'','definition')}</p><DatasetList filters={{...model.filters,...model.node.query}} sources={model.sources} topics={model.concepts} onSelect={select} onCompare={compare} selected={selection}/></aside>}
        </div>
      </section>
      <section id="sources-view" hidden={model.view!=='sources'}><div className="source-grid">{model.sources.map(s=><article className="source-card glass" key={s.id}><div className="source-card-top"><span className="source-country">{s.country}</span>{s.last_error&&<span className="error-text">{t('수집 실패')}</span>}</div><h3>{i18n.field('source',s.id,'name',s.name).text}</h3><p>{s.authority}</p><strong>{i18n.number(s.stored_count??s.dataset_count??0)}<small>{t('건')}</small></strong><div className="card-links"><SourceLink url={s.url}>{t('사이트 방문 ↗')}</SourceLink><SourceLink url={s.docs}>{t('공식 근거 ↗')}</SourceLink></div></article>)}</div></section>
    </main>
    <div className="dataieum-language" role="group" aria-label={t('화면 언어')}><button lang="ko" aria-pressed={locale==='ko'} onClick={()=>i18n.setLocale('ko')}>한국어</button><button lang="en" aria-pressed={locale==='en'} onClick={()=>i18n.setLocale('en')}>English</button></div>
    {selection.length>0&&<div className="compare-tray glass" role="region" aria-label={t('선택한 자료')}><span className="compare-count"><Icon name="compare" size={16}/>{t('선택한 자료')} <b>{selection.length}/4</b></span><button className="primary" disabled={selection.length<2} onClick={()=>setComparing(true)}>{t('비교')}</button><button onClick={()=>{setSelection([]);setComparing(false);}}>{t('선택 지우기')}</button></div>}
    {comparing&&selection.length>=2&&<Compare records={selection} onClose={()=>setComparing(false)}/>}
    {help&&<Help chat={chatControl} state={guideState} onExplore={()=>commit(old=>({...old,view:'explore',mode:'graph'}))} onClose={()=>setHelp(false)}/>}
    {collections&&<Collections selection={selection} filters={model.filters} onClose={()=>setCollections(false)} onOpen={(filters,ids)=>{
      restoreRequest.current?.abort();const restoring=new AbortController();restoreRequest.current=restoring;
      select(null);commit(old=>({...old,filters,view:'explore',mode:'list',node:null}));setSelection([]);
      void (async()=>{const records:Dataset[]=[];for(const id of ids){try{const result=await api<{dataset:Dataset}>('/api/datasets/'+encodeURIComponent(id),{signal:restoring.signal});if(result.dataset?.id===id)records.push(result.dataset);}catch{if(!restoring.signal.aborted)setNotice(t('저장한 자료 일부를 현재 카탈로그에서 찾지 못했습니다.'));}}if(!restoring.signal.aborted)setSelection(records);})();
    }}/>}

  </>;
}
