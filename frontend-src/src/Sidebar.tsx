import {useEffect,useRef,useState} from 'react';
import {i18n,t,useLocale} from './locale';
import type {Bootstrap,Topic} from './types';
import {Icon} from './icons';
export type Screen='graph'|'list'|'sources';
const screens:{id:Screen;icon:'map'|'list'|'sites';label:string}[]=[{id:'graph',icon:'map',label:'지도'},{id:'list',icon:'list',label:'목록'},{id:'sources',icon:'sites',label:'사이트'}];
export function Sidebar({topics,summary,selected,band,screen,onTopic,onAll,onUnclassified,onScreen,onHelp,onCollections}:{topics:Topic[];summary?:Bootstrap['summary'];selected:string;band:string;screen:Screen;onTopic:(id:string)=>void;onAll:()=>void;onUnclassified:()=>void;onScreen:(screen:Screen)=>void;onHelp:()=>void;onCollections:()=>void}) {
  useLocale();const [expanded,setExpanded]=useState(''),[opened,setOpened]=useState(false),region=useRef<HTMLDivElement>(null),toggle=useRef<HTMLButtonElement>(null);
  const mains=topics.filter(t=>/^M\d{2,4}$/.test(t.id));
  const count=(id:string)=>summary?.concept_counts[id]||0;
  useEffect(()=>{document.body.classList.add('catalogue-categories');document.body.dataset.i18nPage='catalogue';return()=>{document.body.classList.remove('catalogue-categories');delete document.body.dataset.i18nPage;};},[]);
  useEffect(()=>{document.body.classList.toggle('catalogue-categories-open',opened);if(opened)region.current?.querySelector<HTMLButtonElement>('button')?.focus();return()=>document.body.classList.remove('catalogue-categories-open');},[opened]);
  useEffect(()=>{if(selected.includes('-'))setExpanded(selected.split('-')[0]);},[selected]);
  const close=()=>{setOpened(false);toggle.current?.focus();};
  const all=()=>{setExpanded('');setOpened(false);onAll();};
  const name=(topic:Topic)=>i18n.topic(topic.id,topic.name);
  return <aside className="sidebar glass"><div className="sidebar-head"><a className="brand" href="/"><svg className="brandmark" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6L18 9L10 19Z" fill="none" stroke="currentColor"/><circle cx="6" cy="6" r="3"/><circle cx="18" cy="9" r="2.5"/><circle cx="10" cy="19" r="2.5"/></svg><span>{t('데이터이음')}</span></a>
    <button className="catalogue-categories-total" aria-label={t('전체 자료 보기')} aria-current={!selected&&!band} onClick={all}>{summary?t('전체 {count}건 · 전체 보기',{count:i18n.number(summary.datasets||0)}):t('불러오는 중')}</button></div>
    <nav aria-label={t('보기 선택')}>{screens.map(item=><button key={item.id} className={'nav '+(screen===item.id?'active':'')} aria-pressed={screen===item.id} onClick={()=>onScreen(item.id)}><Icon name={item.icon}/><span>{t(item.label)}</span></button>)}</nav>
    <div ref={region} className="sidebar-topics" id="catalogue-main-categories" aria-label={t('큰 주제 선택')} onKeyDown={e=>{if(e.key==='Escape'&&opened){e.preventDefault();close();}if(e.key==='Tab'&&opened){const items=[...region.current!.querySelectorAll<HTMLButtonElement>('button')].filter(b=>b.getClientRects().length);if(e.shiftKey&&document.activeElement===items[0]){e.preventDefault();items.at(-1)?.focus();}else if(!e.shiftKey&&document.activeElement===items.at(-1)){e.preventDefault();items[0]?.focus();}}}}>
      <button className="catalogue-categories-close" onClick={close}><Icon name="close" size={16}/><span>{t('주제 선택 닫기')}</span></button>
      <div id="side-concepts">{mains.map(topic=><div key={topic.id} className={'catalogue-category-group '+(expanded===topic.id?'is-open ':'')+(selected.split('-')[0]===topic.id?'is-selected':'')}>
        <button id={'category-'+topic.id} className="topic-nav catalogue-main-topic" aria-expanded={expanded===topic.id} aria-controls={'subtopics-'+topic.id} aria-current={selected===topic.id} onClick={()=>{setExpanded(old=>old===topic.id?'':topic.id);onTopic(topic.id);}}><span className="catalogue-category-arrow" aria-hidden="true"><Icon name="chevron" size={14}/></span><span className="catalogue-category-name">{name(topic)}</span><span className="catalogue-category-count">{i18n.number(count(topic.id))}</span></button>
        <div id={'subtopics-'+topic.id} className="catalogue-subtopics" role="group" aria-labelledby={'category-'+topic.id} hidden={expanded!==topic.id}>{topics.filter(c=>c.id.startsWith(topic.id+'-')).map(child=><button key={child.id} className="topic-nav catalogue-subtopic" aria-current={selected===child.id} onClick={()=>{onTopic(child.id);setOpened(false);}}><span className="catalogue-category-name">{name(child)}</span><span className="catalogue-category-count">{i18n.number(count(child.id))}</span></button>)}</div>
      </div>)} {summary&&<button className="topic-nav catalogue-unclassified" aria-current={band==='unclassified'} onClick={()=>{setExpanded('');setOpened(false);onUnclassified();}}><span className="catalogue-category-name">{t('주제 미지정')}</span><span className="catalogue-category-count">{i18n.number(Math.max(0,(summary?.datasets||0)-mains.reduce((n,topic)=>n+count(topic.id),0)))}</span></button>}</div>
    </div>
    <button ref={toggle} className="catalogue-categories-toggle" aria-controls="catalogue-main-categories" aria-expanded={opened} onClick={()=>setOpened(!opened)}><Icon name="filter" size={16}/><span>{t('주제 선택')}</span></button>
    <div className="sidebar-foot"><button className="collections-button" onClick={onCollections}><Icon name="bookmark"/><span>{t('저장한 자료')}</span></button><button id="catalogue-guide-help" className="catalogue-guide" aria-label={t('이용 안내')} onClick={onHelp}><Icon name="help"/><span className="catalogue-guide-help-label">{t('이용 안내')}</span></button></div>
  </aside>;
}
