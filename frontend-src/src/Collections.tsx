import {useEffect,useRef,useState} from 'react';
import {t,useLocale} from './locale';
import type {Dataset,Filters} from './types';
type Collection={id:string;name:string;ids:string[];filters:Filters;created:string};
const KEY='dataieum.collections.v1';
function read():Collection[]{
  try{const data=JSON.parse(localStorage.getItem(KEY)||'[]');if(!Array.isArray(data)||data.length>40)return [];return data.filter((r:Collection)=>typeof r.id==='string'&&typeof r.name==='string'&&r.name.length<=80&&Array.isArray(r.ids)&&r.ids.length<=4&&r.ids.every(id=>typeof id==='string'&&id.length<=2048)&&r.filters&&Object.values(r.filters).every(v=>typeof v==='string'&&v.length<=200));}catch{return [];}
}
export function Collections({selection,filters,onOpen,onClose}:{selection:Dataset[];filters:Filters;onOpen:(filters:Filters,ids:string[])=>void;onClose:()=>void}) {
  const locale=useLocale(),dialog=useRef<HTMLDialogElement>(null),[items,setItems]=useState(read),[name,setName]=useState(''),[error,setError]=useState('');
  useEffect(()=>{const previous=document.activeElement as HTMLElement|null;dialog.current?.showModal();return()=>{dialog.current?.close();previous?.focus();};},[]);
  const save=(next:Collection[])=>{try{localStorage.setItem(KEY,JSON.stringify(next));setItems(next);setError('');}catch{setError(locale==='ko'?'이 브라우저에 저장할 수 없습니다.':'This browser could not save the collection.');}};
  return <dialog className="collections-dialog glass" ref={dialog} onCancel={e=>{e.preventDefault();onClose();}}><header><h2>{locale==='ko'?'저장한 자료':'Collections'}</h2><button onClick={onClose} aria-label={t('닫기')}>×</button></header><p>{locale==='ko'?'이 브라우저에 자료 선택과 검색 조건을 저장합니다.':'Save selected datasets and search filters in this browser.'}</p>
    <form onSubmit={e=>{e.preventDefault();if(!name.trim()||items.length>=40)return;save([...items,{id:crypto.randomUUID(),name:name.trim(),ids:selection.map(r=>r.id),filters:{...filters},created:new Date().toISOString()}]);setName('');}}><input value={name} onChange={e=>setName(e.target.value)} maxLength={80} required placeholder={locale==='ko'?'묶음 이름':'Collection name'} aria-label={locale==='ko'?'묶음 이름':'Collection name'}/><button disabled={items.length>=40}>{t('저장')}</button></form>
    {error&&<p role="alert">{error}</p>}<ul>{items.map(item=><li key={item.id}><button onClick={()=>{onOpen(item.filters,item.ids);onClose();}}>{item.name}<small>{item.ids.length} {locale==='ko'?'개 자료':'datasets'}</small></button><button onClick={()=>save(items.filter(r=>r.id!==item.id))} aria-label={`${item.name} ${t('삭제')}`}>{t('삭제')}</button></li>)}</ul>
  </dialog>;
}
