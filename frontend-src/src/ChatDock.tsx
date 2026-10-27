import {useEffect,useImperativeHandle,useRef,useState} from 'react';
import {graphResult} from './chat-result.js';
import type {GraphController} from './canvas-graph';
import {i18n,t,useLocale} from './locale';
import {Icon} from './icons';

export type GuideState={busy:boolean;result:{state:string;hasDatasets:boolean}|null;issue:boolean;official:number};
export type ChatControl={open:()=>void;focus:()=>void;close:()=>void;highlight:(target:string)=>void;example:(text:string)=>void};
export function ChatDock({graph,control,onGuide}:{graph:React.RefObject<GraphController|null>;control:React.Ref<ChatControl>;onGuide:(state:GuideState)=>void}) {
  const [guide,setGuide]=useState<GuideState>({busy:false,result:null,issue:false,official:0});
  const highlight=useRef(''),example=useRef('');
  useEffect(()=>onGuide(guide),[guide,onGuide]);
  const [open,setOpen]=useState(new URLSearchParams(location.search).get('view')==='chat');
  const [mounted,setMounted]=useState(open),[large,setLarge]=useState(false),[phase,setPhase]=useState('composer'),[ready,setReady]=useState(false);
  const frame=useRef<HTMLIFrameElement>(null),trigger=useRef<HTMLButtonElement>(null),panel=useRef<HTMLDialogElement>(null);
  const locale=useLocale();
  const send=(action:string,extra:Record<string,unknown>={})=>frame.current?.contentWindow?.postMessage({type:'dataieum-chat',version:1,action,...extra},location.origin);
  const close=()=>{setOpen(false);setLarge(false);trigger.current?.focus();};
  useImperativeHandle(control,()=>({open(){setMounted(true);setOpen(true);setLarge(false);},focus(){setMounted(true);setOpen(true);setLarge(false);send('open');},close(){setOpen(false);setLarge(false);},highlight(target){highlight.current=target;send('guide-highlight',{target});},
    example(text){setMounted(true);setOpen(true);setLarge(false);example.current=text;send('guide-example',{text});}}));
  useEffect(()=>{
    const receive=(event:MessageEvent)=>{
      if(event.origin!==location.origin||event.source!==frame.current?.contentWindow)return;
      const d=event.data;
      if(!d||d.type!=='dataieum-chat'||d.version!==1)return;
      setReady(true);
      if(d.action==='locale'&&['ko','en'].includes(d.locale))i18n.setLocale(d.locale);
      else if(d.action==='phase'&&['composer','conversation'].includes(d.phase))setPhase(d.phase);
      else if(d.action==='search-start'){setPhase('conversation');graph.current?.beginRequest();setGuide(old=>({...old,busy:true,result:null,issue:false}));}
      else if(d.action==='result'){const result=graphResult(d.result);if(result){void graph.current?.showResult(result);setGuide(old=>({...old,result:{state:result.state,hasDatasets:result.groups.some((group:{sites:{evidence:unknown[]}[]})=>group.sites.some(site=>site.evidence.length>0))}}));}}
      else if(d.action==='search-end')setGuide(old=>({...old,busy:false,issue:!old.result}));
      else if(d.action==='official-opened')setGuide(old=>({...old,official:old.official+1}));
      else if(d.action==='reset'){setPhase('composer');graph.current?.reset();setGuide(old=>({...old,busy:false,result:null,issue:false}));}
      else if(d.action==='toggle-size')setLarge(value=>!value);
      else if(d.action==='close'){setOpen(false);setLarge(false);trigger.current?.focus();}
    };
    window.addEventListener('message',receive);return()=>window.removeEventListener('message',receive);
  },[graph]);
  useEffect(()=>{send('locale',{locale});},[locale,mounted]);
  useEffect(()=>{
    document.body.dataset.chatPhase=open?phase:'closed';
    document.body.dataset.chatExpanded=String(large&&open);
    const dialog=panel.current;if(!dialog)return;
    if(large&&open&&!dialog.matches(':modal')){dialog.close();dialog.showModal();}
    else if(!large&&dialog.matches(':modal')){dialog.close();dialog.show();}
    send('layout',{expanded:large});if(open)send('open');
    graph.current?.refresh();
    if(matchMedia('(prefers-reduced-motion: reduce)').matches)graph.current?.dockChanged();
  },[open,large,phase,graph]);
  // The dock animates its height; the graph re-fits only once the final size is known.
  useEffect(()=>{
    const dialog=panel.current;if(!dialog)return;
    const settled=(event:TransitionEvent)=>{if(event.target===dialog&&event.propertyName==='height')graph.current?.dockChanged();};
    dialog.addEventListener('transitionend',settled);return()=>dialog.removeEventListener('transitionend',settled);
  },[graph]);
  return <dialog ref={panel} id="catalogue-chat-panel" open={!large} data-phase={open?phase:'closed'} data-expanded={large} aria-label={t('데이터 채팅')} onCancel={event=>{event.preventDefault();large?setLarge(false):close();}}>
    <button id="chat-mode" ref={trigger} hidden={open} onClick={()=>{setMounted(true);setOpen(true);}} onDoubleClick={()=>{setMounted(true);setOpen(true);setLarge(true);}} aria-expanded={open}><span className="chat-mode-icon"><Icon name="spark" size={16}/></span><span className="chat-mode-label">{t('AI로 데이터 찾기  ↗').replace(/\s*↗$/,'')}</span></button>
    {open&&!ready&&<div className="chat-dock-tools"><button onClick={()=>setLarge(!large)} aria-label={t(large?'원래 크기로':'큰 화면으로')}><Icon name={large?'shrink':'expand'} size={16}/></button><button onClick={close} aria-label={t('채팅 접기')}><Icon name="close" size={16}/></button></div>}
    {mounted&&<iframe id="catalogue-chat-frame" className="catalogue-chat-frame" ref={frame} src="/chat/embed" title={t('데이터이음 채팅')} hidden={!open} inert={!open} onLoad={()=>{send('locale',{locale});send('layout',{expanded:large});send('guide-highlight',{target:highlight.current});if(open)send('open');if(example.current){send('guide-example',{text:example.current});example.current='';}}}/>}
  </dialog>;
}
