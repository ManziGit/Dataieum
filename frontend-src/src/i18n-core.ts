import raw from './translations.json';
import type {Locale} from './types';
type Texts=Record<string,string>;
type TranslationData={messages:Record<string,Partial<Record<Locale,string>>>;topics:Record<string,{original:Texts;ko:Texts;en:Texts}>;metadata:{entityType:string;id:string;field:string;targetLanguage:string;original:string;text:string}[]};
const data=raw as unknown as TranslationData;
const hub=document.querySelector<HTMLMetaElement>('meta[name="dataieum-brand"]')?.content==='datahub';
let locale:Locale='ko';
try{const saved=localStorage.getItem('dataieum.locale');if(saved==='ko'||saved==='en')locale=saved;}catch{}
const listeners=new Set<()=>void>();
type Params=Record<string,unknown>|(()=>Record<string,unknown>);
const bindings=new Map<HTMLElement,Map<string|null,{source:string;params:Params}>>();
let prune:number|undefined;
function text(source:string,params:Params={}) {
  const value=String(source??''),canonical=hub?value.replaceAll('데이터 허브','데이터이음').replaceAll('Data Hub','Dataieum'):value;
  let translated=data.messages[canonical]?.[locale]??canonical;
  if(hub)translated=translated.replaceAll('데이터이음',locale==='ko'?'데이터 허브':'Data Hub').replaceAll('Dataieum','Data Hub');
  const values=typeof params==='function'?params():params;
  return translated.replace(/\{([a-zA-Z_][\w]*)\}/g,(match,key)=>Object.hasOwn(values,key)?String(values[key]):match);
}
const titleSource=document.title;
function paint(element:HTMLElement,source:string,params:Params,attribute:string|null){const value=text(source,params);if(attribute)element.setAttribute(attribute,value);else element.textContent=value;}
function refresh(){
  document.documentElement.lang=locale;document.documentElement.dataset.locale=locale;document.title=text(titleSource);
  for(const [element,entries] of bindings){if(!element.isConnected){bindings.delete(element);continue;}for(const [attribute,binding] of entries)paint(element,binding.source,binding.params,attribute);}
}
export const i18n={
  text,
  number:(value:number)=>Number.isFinite(value)?new Intl.NumberFormat(locale==='ko'?'ko-KR':'en-US').format(value):'—',
  topic(id:string,original:string,field='name'){const entry=data.topics[id];return entry?.original?.[field]===original?entry[locale]?.[field]??original:original;},
  field(kind:string,id:string,field:string,original:string){const entry=data.metadata.find(r=>r.entityType===kind&&r.id===id&&r.field===field&&r.targetLanguage===locale&&r.original===original);return {text:entry?.text??original,original,translated:!!entry};},
  getLocale:()=>locale,
  setLocale(value:Locale){if(!['ko','en'].includes(value)||value===locale)return;locale=value;try{localStorage.setItem('dataieum.locale',value);}catch{}refresh();for(const fn of listeners)fn();},
  subscribe(fn:()=>void){listeners.add(fn);return()=>{listeners.delete(fn);};},
  bind(element:HTMLElement|null,source:string,params:Params={},attribute:string|null=null){
    if(!element)return;
    if(attribute!==null&&!['placeholder','title','aria-label','aria-description'].includes(attribute))throw new Error('Unsupported display attribute');
    const entries=bindings.get(element)||new Map();entries.set(attribute,{source,params});bindings.set(element,entries);paint(element,source,params,attribute);
    if(prune===undefined)prune=window.setTimeout(()=>{prune=undefined;for(const node of bindings.keys())if(!node.isConnected)bindings.delete(node);},0);
  },
};
window.addEventListener('storage',event=>{if(event.key==='dataieum.locale'&&(event.newValue==='ko'||event.newValue==='en'))i18n.setLocale(event.newValue);});
refresh();
