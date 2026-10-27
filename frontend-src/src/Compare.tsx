import {useEffect,useRef,useState} from 'react';
import {api,safeURL} from './api';
import {t,useLocale} from './locale';
import {SourceLink} from './DatasetList';
import type {Dataset} from './types';

type Item={id:string;found:boolean;title?:string;source?:string;url?:string;values?:Record<string,string|null>};
const fields:Record<string,string>={publisher:'제공기관',region:'지역',period:'기준기간 원문',source_modified:'제공처 갱신',format:'제공형식',license:'이용조건',checked_at:'설명 확인',description:'설명'};
export function Compare({records,onClose}:{records:Dataset[];onClose:()=>void}) {
  useLocale();const dialog=useRef<HTMLDialogElement>(null),[items,setItems]=useState<Item[]>([]),[error,setError]=useState('');
  const ids=JSON.stringify(records.map(r=>r.id));
  useEffect(()=>{
    const previous=document.activeElement as HTMLElement|null;
    dialog.current?.showModal();return()=>{dialog.current?.close();previous?.focus();};
  },[]);
  useEffect(()=>{
    const controller=new AbortController();setItems([]);setError('');
    void api<{items:Item[]}>('/api/compare?'+new URLSearchParams({ids}),{signal:controller.signal}).then(data=>{
      const expected:string[]=JSON.parse(ids);
      if(!Array.isArray(data.items)||data.items.length!==expected.length||data.items.some((r,i)=>r.id!==expected[i]||typeof r.found!=='boolean'))throw new Error('비교 응답이 선택한 자료와 일치하지 않습니다.');
      setItems(data.items);
    }).catch(e=>{if(!controller.signal.aborted)setError(String(e.message||e));});
    return()=>controller.abort();
  },[ids]);
  return <dialog ref={dialog} className="compare-dialog glass" onCancel={onClose} aria-labelledby="compare-title"><header><h2 id="compare-title">{t('자료 비교')}</h2><button onClick={onClose} aria-label={t('닫기')}>×</button></header>
    {error?<p role="alert">{t(error)}</p>:!items.length?<p role="status">{t('불러오는 중')}</p>:<div className="comparison-scroll"><table><thead><tr><th>{t('항목')}</th>{items.map(item=><th key={item.id}>{item.found?(safeURL(item.url)?<SourceLink url={item.url}>{item.title}</SourceLink>:item.title):t('자료를 찾을 수 없습니다.')}</th>)}</tr></thead><tbody>{Object.entries(fields).map(([key,label])=><tr key={key}><th>{t(label)}</th>{items.map(item=><td key={item.id}>{item.values?.[key]||t('미상')}</td>)}</tr>)}</tbody></table></div>}
  </dialog>;
}
