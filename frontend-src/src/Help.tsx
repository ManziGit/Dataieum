import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import {i18n,useLocale} from './locale';
import type {ChatControl,GuideState} from './ChatDock';
import {placeGuide} from './guide-place';
import words from './guide-copy.json';
const key='dataieum.guide.v1';
export function guideUnseen(){try{return !new URLSearchParams(location.search).has('view')&&!sessionStorage.getItem('dataieum.pending-chat.v1')&&localStorage.getItem(key)!=='seen'&&sessionStorage.getItem(key)!=='seen';}catch{return false;}}
function remember(){for(const storage of ['localStorage','sessionStorage'] as const)try{window[storage].setItem(key,'seen');}catch{}}
// The welcome card also chooses the language, so the walkthrough itself has four steps.
const WELCOME=0,ASK=1,RESULT=2,MAP=3,SOURCE=4;
// A measured spot beside the dock, 'dock' (no room: sit directly above it and scroll), or null (CSS default).
type Spot={top:number;left:number}|'dock'|null;
export function Help({onClose,onExplore,chat,state}:{onClose:()=>void;onExplore:()=>void;chat:React.RefObject<ChatControl|null>;state:GuideState}) {
  const locale=useLocale(),[step,setStep]=useState(WELCOME),dialog=useRef<HTMLDialogElement>(null),prior=useRef<HTMLElement|null>(null),official=useRef(state.official);
  const [spot,setSpot]=useState<Spot>(null),[compact,setCompact]=useState(false),[layout,setLayout]=useState(0);
  const finish=()=>{remember();chat.current?.highlight('');onClose();};
  useEffect(()=>{prior.current=document.activeElement as HTMLElement|null;return()=>{dialog.current?.close();chat.current?.highlight('');prior.current?.focus();};},[chat]);
  useEffect(()=>{
    const node=dialog.current!;node.close();if(step===WELCOME)node.showModal();else node.show();
    if(step===MAP)chat.current?.close();else if(step>WELCOME)chat.current?.open();
    chat.current?.highlight(step===ASK||(step===RESULT&&!state.result?.hasDatasets)?'input':step===RESULT?'results':step===SOURCE?'source':'');
    const target=step===MAP?document.getElementById('graph-wrap'):null;
    target?.setAttribute('data-guide-highlight','true');
    return()=>target?.removeAttribute('data-guide-highlight');
  },[step,chat,state.result?.hasDatasets]);
  useEffect(()=>{if(state.busy)setStep(old=>old>=ASK?ASK:old);else if(state.result)setStep(old=>old===ASK?RESULT:old);},[state.busy,state.result]);
  useEffect(()=>{if(step===SOURCE&&state.official>official.current){remember();onClose();}official.current=state.official;},[state.official,step,onClose]);
  // Re-measure whenever the viewport, the chat dock or this card changes size.
  useEffect(()=>{
    const bump=()=>{setCompact(false);setLayout(n=>n+1);},dock=document.getElementById('catalogue-chat-panel');
    const observer=new ResizeObserver(bump);if(dock)observer.observe(dock);
    window.addEventListener('resize',bump);
    return()=>{observer.disconnect();window.removeEventListener('resize',bump);};
  },[]);
  useEffect(()=>{setCompact(false);},[step,state.busy,locale]);
  // Chat steps sit beside the dock instead of on top of the input they point at.
  useLayoutEffect(()=>{
    const card=dialog.current,dock=document.getElementById('catalogue-chat-panel');
    if(!card||step===WELCOME||step===MAP||!dock||document.body.dataset.chatExpanded==='true'){setSpot(null);return;}
    // Measure the size the card has when anchored; the 'dock' fallback caps its height and would under-report it.
    const mode=card.dataset.anchored;card.dataset.anchored='true';
    const rect=card.getBoundingClientRect(),target=dock.getBoundingClientRect();card.dataset.anchored=mode;
    const next=target.height?placeGuide({width:rect.width,height:rect.height},target,{width:innerWidth,height:innerHeight},innerWidth<=700?12:16):null;
    if(!next&&!compact){setCompact(true);return;}
    setSpot(old=>!next?'dock':old&&old!=='dock'&&Math.abs(old.top-next.top)<1&&Math.abs(old.left-next.left)<1?old:next);
  },[step,compact,layout,locale,state.busy,state.issue,state.result]);
  const w=words[locale],total=w.steps.length;
  const content=step===WELCOME?[w.welcome,w.intro,w.start]:step===ASK?[state.busy?w.waiting:state.issue?w.interrupted:w.ask,state.busy?w.waitingBody:state.issue?w.interruptedBody:w.askBody,w.input]:step===RESULT?(state.result?.hasDatasets?[w.result,w.resultBody,w.toMap]:state.result?.state==='clarify'?[w.clarify,w.clarifyBody,w.retry]:[w.empty,w.emptyBody,w.retry]):step===MAP?[w.graph,w.graphBody,w.toData]:[w.official,w.officialBody,w.done];
  const next=()=>{onExplore();if(step===WELCOME){remember();setStep(state.result?RESULT:ASK);}else if(step===ASK)chat.current?.focus();else if(step===RESULT)setStep(state.result?.hasDatasets?MAP:ASK);else if(step===MAP)setStep(SOURCE);else finish();};
  return <dialog ref={dialog} id="catalogue-guide" className="catalogue-guide" data-step={step} data-anchored={spot==='dock'?'dock':spot?'true':'false'} data-compact={String(compact)}
    style={spot&&spot!=='dock'?{'--guide-top':spot.top+'px','--guide-left':spot.left+'px'} as React.CSSProperties:undefined}
    aria-labelledby="catalogue-guide-title" aria-describedby="catalogue-guide-description" onCancel={e=>{e.preventDefault();finish();}} onKeyDown={e=>{if(e.key==='Escape'){e.preventDefault();finish();}}}>
    {step===WELCOME&&<div className="dataieum-language catalogue-guide-languages" role="group" aria-label={w.languageLabel}><button lang="ko" aria-pressed={locale==='ko'} onClick={()=>i18n.setLocale('ko')}>한국어</button><button lang="en" aria-pressed={locale==='en'} onClick={()=>i18n.setLocale('en')}>English</button></div>}
    {step>WELCOME&&<><ol className="catalogue-guide-progress" aria-hidden="true">{w.steps.map((label,index)=><li key={index} aria-current={index===step-1?'step':undefined}>{label}</li>)}</ol>
      <p className="catalogue-guide-status" role="status">{w.stepStatus.replace('{n}',String(step)).replace('{total}',String(total)).replace('{label}',w.steps[step-1])}</p></>}
    <h2 id="catalogue-guide-title">{content[0]}</h2><p id="catalogue-guide-description">{content[1]}</p>
    {step===ASK&&!state.busy&&<button className="catalogue-guide-example" onClick={()=>chat.current?.example(w.exampleQuery)}><span>{w.exampleLabel}</span>{w.exampleQuery}</button>}
    <div className="catalogue-guide-actions">{step>ASK&&<button id="catalogue-guide-back" onClick={()=>setStep(step-1)}>{w.back}</button>}<button id="catalogue-guide-next" disabled={step===ASK&&state.busy} onClick={next}>{content[2]}</button></div><button id="catalogue-guide-skip" onClick={finish}>{step===WELCOME?w.skip:w.stop}</button>
  </dialog>;
}
