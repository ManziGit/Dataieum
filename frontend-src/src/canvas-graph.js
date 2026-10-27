import {api} from './api';
export function mountGraph(options) {
 const lifetime=new AbortController(),timers=new Set(),frames=new Set(),requests=new Set();
 let disposed=false;
 const listen=(target,event,fn,config={})=>target?.addEventListener(event,fn,{...config,signal:lifetime.signal});
 const setTimeout=(fn,ms)=>{const id=window.setTimeout(()=>{timers.delete(id);if(!disposed)fn();},ms);timers.add(id);return id;};
 const clearTimeout=id=>{timers.delete(id);window.clearTimeout(id);};
 const requestAnimationFrame=fn=>{const id=window.requestAnimationFrame(now=>{frames.delete(id);if(!disposed)fn(now);});frames.add(id);return id;};
 const cancelAnimationFrame=id=>{frames.delete(id);window.cancelAnimationFrame(id);};
 const $=selector=>document.querySelector(selector);
 const catalogueI18n=options.i18n;
 const ct=(value,params={})=>catalogueI18n.text(value,params);
 const cn=value=>catalogueI18n.number(value);
 const topicText=(id,original,field='name')=>catalogueI18n.topic(id,original||'',field);
 const metadataText=(kind,item,field)=>catalogueI18n.field(kind,item?.id,field,item?.[field]||'').text;
 const state=new Proxy({}, {get:(_,key)=>options.getState()[key]});
 const concept=id=>state.concepts.find(c=>c.id===id);
 const source=id=>state.sources.find(c=>c.id===id);
 const graphView=()=>state.view==='explore'&&state.mode==='graph';
 const notice=(value,error=false)=>options.onNotice(ct(value||''),error);
function nodeDisplayTitle(n){
 if(n.kind==='dataset')return metadataText('dataset',n.record||{id:n.id,title:n.title},'title');
 if(n.kind==='source')return metadataText('source',source(n.query?.source||n.id)||{id:n.id,name:n.title},'name');
 if(n.query?.concept)return topicText(n.query.concept,n.title);
 return ct(n.title);
}
function nodeDisplaySubtitle(n){
 if(n.catalogueFocusRole)return ct(n.catalogueFocusRole);
 if(n.kind==='dataset')return metadataText('source',source(n.record?.source_id),'name')||n.record?.publisher||n.subtitle||'';
 return ct('{count}건',{count:cn(n.count||0)});
}
function refreshNodeLabel(n){
 const title=nodeDisplayTitle(n),subtitle=nodeDisplaySubtitle(n);
 const label=title.length>48?title.slice(0,47)+'…':title;
 const sub=subtitle.length>38?subtitle.slice(0,37)+'…':subtitle;
 paint.font=`600 ${n.titleSize}px ${fontFamily}`;const width=paint.measureText(label).width;
 paint.font=`400 12px ${fontFamily}`;n.labelWidth=Math.ceil(Math.max(width,paint.measureText(sub).width)+12);
 return {label,subtitle:sub};
}
function nodeAccessibleTitle(n){return nodeDisplayTitle(n)+(n.kind==='dataset'?'':', '+ct('{count}건',{count:cn(n.count||0)}));}

const canvas=options.canvas,paint=canvas.getContext('2d',{alpha:false});
const starCanvas=document.createElement('canvas');starCanvas.id='graph-stars';starCanvas.setAttribute('aria-hidden','true');canvas.after(starCanvas);
const starPaint=starCanvas.getContext('2d'),starSprites=new Map();
let starTimer=null,starsForFrame=[];
const spaceCanvas=document.createElement('canvas');
const cosmosBackdrop=document.createElement('div');cosmosBackdrop.className='cosmos-backdrop';cosmosBackdrop.setAttribute('aria-hidden','true');
const cosmosCanvas=document.createElement('canvas'),cosmosLight=document.createElement('canvas');
cosmosBackdrop.append(cosmosCanvas,cosmosLight);document.body.prepend(cosmosBackdrop);
const cosmosPaint=cosmosCanvas.getContext('2d'),cosmosLightPaint=cosmosLight.getContext('2d');
const spaceStars=(()=>{
 let seed=28173;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
 return Array.from({length:2400},()=>({x:(random()-.5)*2.8,y:(random()-.5)*2.8,depth:1+random()*4,r:.2+Math.pow(random(),3)*1.6,alpha:.16+random()*.3})).map(star=>{
  const hue=random(),color=hue<.42?'#edf1ff':hue<.68?'#a8caff':hue<.85?'#ffad91':'#ffe0aa';
  return {...star,color,twinkle:random()<.025,phase:random()*Math.PI*2,speed:.00012+random()*.0001};
 });
})();
const spaceTwinkles=spaceStars.filter(star=>star.twinkle);
let spaceMeteor=null,nextSpaceMeteor=performance.now()+25000+Math.random()*30000;
const camera={box:[0,0,1200,760],path:[],focus:null};
// True while the camera still shows the automatic overview fit; any other camera owner clears it.
let overviewFitted=false;
let sceneHeight=760,sceneWidth=0,graphNodes=[],graphData=null,graphSequence=0,graphLoading=false,zoomFrame=0;
let rootScene=null,detailTimer=null,detailDue=0,detailBatch=null,pendingDetails=0,hoveredNode=null,focusedNode=null,pinnedNode=null;
let graphRect={left:0,top:0,width:0,height:0},pixelRatio=1,movingUntil=0,labelsDirty=true;
let pointer=null,simulation=null,lastFrameTime=0;
const reducedGraphMotion=matchMedia('(prefers-reduced-motion: reduce)').matches;
const interactiveOpacity=.05;
const entityNodes=new Map();
let sceneNodes=[];
const graphCache=new Map(),overviewGraphs=new Map(),sceneCache=new Map(),layoutOffsets=new Map();
const fontFamily=getComputedStyle(document.body).fontFamily;
const zoomScale=()=>1200/camera.box[2];
function graphKey(query){return new URLSearchParams(Object.entries(query).sort()).toString();}
function graphQuery(){const query=Object.fromEntries(Object.entries(options.getState().filters).filter(([,v])=>v));if(camera.topic===query.concept)delete query.concept;return query;}
function graphCaption(){const count=(camera.topic&&findTopicNode(camera.topic)?.count)??graphData?.represented??0;const path=camera.topic?[camera.topic.split('-')[0],camera.topic].filter((id,index,ids)=>ids.indexOf(id)===index).map(id=>topicText(id,concept(id)?.name)):camera.path.map(name=>ct(name));return [...path,ct('{count}건',{count:cn(count)})].join(' / ');}
function paintSpaceBackground(){
 const w=graphRect.width,h=graphRect.height;
 spaceCanvas.width=canvas.width;spaceCanvas.height=canvas.height;
 const p=spaceCanvas.getContext('2d');p.scale(pixelRatio,pixelRatio);
 const sky=p.createLinearGradient(0,0,w*.35,h);
 sky.addColorStop(0,'#040711');sky.addColorStop(.55,'#0a1021');sky.addColorStop(1,'#050813');
 p.fillStyle=sky;p.fillRect(0,0,w,h);
 function cloud(x,y,rx,ry,color,angle=0){
  p.save();p.translate(x*w,y*h);p.rotate(angle);p.scale(rx*w,ry*h);
  const glow=p.createRadialGradient(0,0,0,0,0,1);glow.addColorStop(0,color);glow.addColorStop(1,'rgba(0,0,0,0)');
  p.fillStyle=glow;p.fillRect(-1,-1,2,2);p.restore();
 }
 cloud(.73,.3,.58,.48,'rgba(35,78,138,.22)');
 cloud(.42,.72,.5,.42,'rgba(89,41,125,.17)');
 cloud(.83,.85,.4,.27,'rgba(28,63,116,.13)');
 cloud(.55,.48,.72,.065,'rgba(164,174,218,.035)',-.48);
 cloud(.57,.49,.65,.12,'rgba(109,104,167,.045)',-.48);
 const vignette=p.createRadialGradient(w*.55,h*.48,Math.min(w,h)*.2,w*.55,h*.48,Math.max(w,h)*.78);
 vignette.addColorStop(0,'rgba(0,0,0,0)');vignette.addColorStop(1,'rgba(0,0,0,.44)');p.fillStyle=vignette;p.fillRect(0,0,w,h);
}
function spaceStarPosition(star){
 const panX=reducedGraphMotion?0:(camera.box[0]+camera.box[2]/2-600)/1200;
 const panY=reducedGraphMotion?0:(camera.box[1]+camera.box[3]/2-sceneHeight/2)/1200;
 const advance=reducedGraphMotion?0:Math.max(-.15,Math.tanh(Math.log2(Math.max(.001,zoomScale()))/12)*.65);
 const perspective=star.depth/(star.depth-advance);
 const wrap=value=>((value+1.4)%2.8+2.8)%2.8-1.4;
 return {x:graphRect.width/2+wrap(star.x-panX*.55/star.depth)*graphRect.width/2*perspective,
  y:graphRect.height/2+wrap(star.y-panY*.55/star.depth)*graphRect.height/2*perspective};
}
function paintSpaceStars(context=paint){
 for(const star of spaceStars){
  const {x,y}=spaceStarPosition(star);
  if(x<0||y<0||x>graphRect.width||y>graphRect.height)continue;
  context.globalAlpha=star.alpha;context.fillStyle=star.color;
  context.beginPath();context.arc(x,y,star.r,0,Math.PI*2);context.fill();
 }
 context.globalAlpha=1;
}
function sizeScene(){
 const rect=graphView()?canvas.getBoundingClientRect():{left:0,top:0,width:innerWidth,height:innerHeight};if(!rect.width||!rect.height)return;
 const nextHeight=1200*rect.height/rect.width;
 if(sceneWidth&&Math.abs(sceneHeight-nextHeight)>1){const h=camera.box[2]*nextHeight/1200;camera.box[1]+=(camera.box[3]-h)/2;camera.box[3]=h;}
 else if(!sceneWidth)camera.box[3]=camera.box[2]*nextHeight/1200;
 sceneWidth=rect.width;sceneHeight=nextHeight;graphRect=rect;
 pixelRatio=Math.min(devicePixelRatio||1,2);
 const w=Math.round(rect.width*pixelRatio),h=Math.round(rect.height*pixelRatio);
 if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h;starCanvas.width=w;starCanvas.height=h;paintSpaceBackground();labelsDirty=true;}
}
function fitTopicOverview(animate=false,start=camera.box){
 if(!graphView()||!rootScene||rootScene.data.view!=='topics_v1'||!sceneWidth||(!animate&&document.body.dataset.chatPhase&&document.body.dataset.chatPhase!=='closed'))return;
 let nodes=[];function collect(scene){for(const node of scene.nodes){nodes.push(node);if(node.child)collect(node.child);}}collect(rootScene);
 const selected=camera.topic?findTopicNode(camera.topic):null;
 if(selected)nodes=[selected,...(selected.level==='main'?selected.child?.nodes||[]:[])];
 if(!nodes.length)return;
 const rect=canvas.getBoundingClientRect(),mobile=rect.width<700;
 const sidebar=document.querySelector('.sidebar')?.getBoundingClientRect();
 const filters=document.querySelector('.filters')?.getBoundingClientRect(),heading=document.querySelector('.panel-head')?.getBoundingClientRect();
 const dock=document.getElementById('catalogue-chat-panel')?.getBoundingClientRect(),controls=document.querySelector('.zoom')?.getBoundingClientRect();
 const labelPad=Math.min(Math.max(40,...nodes.map(n=>n.labelWidth/2)),mobile?rect.width*.25:Infinity);
 const left=(mobile?14:Math.max(14,(sidebar?.right||285)-rect.left+20))+labelPad;
 const reading=document.querySelector('.catalogue-node-panel:not([hidden]),#detail:not([hidden])')?.getBoundingClientRect();
 const right=Math.min(rect.width-18,!mobile&&reading?.width?reading.left-rect.left-18:Infinity)-labelPad;
 const top=Math.max(110,(filters?.bottom||0)-rect.top,(heading?.bottom||0)-rect.top)+26;
 let bottom=rect.height-26;
 for(const ui of [dock,controls])if(ui?.height&&ui.top-rect.top>top+80)bottom=Math.min(bottom,ui.top-rect.top-14);
 bottom-=48;
 if(right<=left||bottom<=top)return;
 const xs=nodes.map(n=>n.x),ys=nodes.map(n=>n.y),minX=Math.min(...xs),maxX=Math.max(...xs),minY=Math.min(...ys),maxY=Math.max(...ys);
 const centerX=selected?selected.x:(minX+maxX)/2,centerY=selected?selected.y:(minY+maxY)/2;
 const spanX=2*Math.max(centerX-minX,maxX-centerX),spanY=2*Math.max(centerY-minY,maxY-centerY);
 const unit=Math.max(spanX/(right-left),spanY/(bottom-top),1200/rect.width/(selected?(selected.level==='main'?3:4):(mobile?1.10:1.20)));
 const destination=[centerX-(left+right)/2*unit,centerY-(top+bottom)/2*unit,rect.width*unit,rect.height*unit];
 camera.focus=selected?{x:selected.x,y:selected.y}:null;overviewFitted=true;moveTopicCamera(destination,animate,start);
}
function resetMap(clearTopic=true){
 cancelTopicFlight();centeredGraphNode=null;overviewFitted=false;topicNavigationSequence++;camera.topic=null;camera.path=[];camera.box=[0,0,1200,sceneHeight];camera.focus=null;simulation=null;
 if(clearTopic)options.onReset();else applyBox();
}
function graphRequest(query){
 const key=graphKey(query);
 if(overviewGraphs.has(key))return Promise.resolve(overviewGraphs.get(key));
 if(graphCache.has(key)){const cached=graphCache.get(key);graphCache.delete(key);graphCache.set(key,cached);return cached;}
 const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),30000);requests.add(controller);
 const request=api('/api/graph?'+key,{signal:controller.signal}).catch(error=>{if(graphCache.get(key)===request)graphCache.delete(key);if(error.name==='AbortError')throw new Error('하위 자료 응답이 지연되어 다시 시도합니다.');throw error;}).finally(()=>{clearTimeout(timeout);requests.delete(controller);});
 graphCache.set(key,request);if(graphCache.size>80)graphCache.delete(graphCache.keys().next().value);
 return request;
}
async function loadGraph(query){
 centeredGraphNode=null;cancelTopicFlight();
 const sequence=++graphSequence,manualSequence=topicManualSequence;graphLoading=true;window.dispatchEvent(new CustomEvent('dataieum:graph-status',{detail:{phase:'loading'}}));clearTimeout(detailTimer);detailTimer=null;canvas.setAttribute('aria-busy','true');
 options.onLoading(true);
 try{
  const result=await graphRequest(query);if(sequence!==graphSequence)return;
  if(rootScene)releaseScene(rootScene);rootScene=null;simulation=null;
  notice('');graphData=result;
  // Accept the required filter data, but leave a newer manual camera untouched.
  const alignCamera=manualSequence===topicManualSequence;
  if(alignCamera){camera.box=[0,0,1200,sceneHeight];camera.focus=null;}
  options.onSelect(null);renderGraph();if(alignCamera)fitTopicOverview();window.dispatchEvent(new CustomEvent('dataieum:graph-status',{detail:{phase:'ready'}}));
 }catch(error){if(sequence===graphSequence){notice(error.message,true);window.dispatchEvent(new CustomEvent('dataieum:graph-status',{detail:{phase:'error'}}));}}
 finally{if(sequence===graphSequence){graphLoading=false;queueGraphDetails();canvas.setAttribute('aria-busy','false');options.onLoading(false);}}
}
let topicFlight=0,topicNavigationSequence=0,centeredGraphNode=null;
let topicManualSequence=0;
function cancelTopicFlight(){cancelAnimationFrame(topicFlight);topicFlight=0;}
// Manual input also invalidates pending navigation; internal alignment only stops frames.
function cancelTopicNavigation(){topicManualSequence++;centeredGraphNode=null;overviewFitted=false;cancelTopicFlight();}
function findTopicNode(id,scene=rootScene){
 if(!scene)return null;
 for(const node of scene.nodes){
  if(node.query?.concept===id&&['main','subtopic'].includes(node.level))return node;
  const child=findTopicNode(id,node.child);if(child)return child;
 }
 return null;
}
function moveTopicCamera(destination,animate,start){
 cancelTopicFlight();
 if(!animate||reducedGraphMotion){camera.box=destination;movingUntil=0;applyBox();return;}
 const origin=[...start],began=performance.now();
 function step(now){
  const progress=Math.min(1,(now-began)/420),ease=1-(1-progress)**3;
  camera.box=origin.map((value,index)=>value+(destination[index]-value)*ease);
  movingUntil=progress<1?now+80:0;applyBox();
  topicFlight=progress<1?requestAnimationFrame(step):0;
 }
 topicFlight=requestAnimationFrame(step);
}
function centerGraphNode(node,animate=true){
 if(!node||node.scene?.disposed||!graphView())return;
 centeredGraphNode=node;overviewFitted=false;cancelTopicFlight();
 const root=rootScene,version=graphSequence,manual=topicManualSequence;
 // Measure next frame, after the click's detail/panel wrappers have opened.
 topicFlight=requestAnimationFrame(()=>{
  topicFlight=0;
  if(centeredGraphNode!==node||root!==rootScene||version!==graphSequence||manual!==topicManualSequence||node.scene?.disposed||!graphView())return;
  const rect=canvas.getBoundingClientRect();if(!rect.width||!rect.height)return;
  const bounds=selector=>document.querySelector(selector)?.getBoundingClientRect();
  const mobile=rect.width<=700,sidebar=bounds('.sidebar'),filters=bounds('.filters'),heading=bounds('.panel-head');
  const readings=[...document.querySelectorAll('.catalogue-node-panel:not([hidden]),#detail:not([hidden])')].map(panel=>panel.getBoundingClientRect());
  const dock=document.getElementById('catalogue-chat-panel')?.getBoundingClientRect(),controls=bounds('.zoom');
  let left=mobile?14:Math.max(14,(sidebar?.right||rect.left)-rect.left+20),right=rect.width-14;
  const top=Math.max(100,(filters?.bottom||rect.top)-rect.top,(heading?.bottom||rect.top)-rect.top)+20;
  let bottom=rect.height-24;
  for(const ui of [dock,controls])if(ui?.width&&ui.height&&ui.top-rect.top>top)bottom=Math.min(bottom,ui.top-rect.top-14);
  for(const reading of readings)if(reading.width&&reading.height){
   if(mobile)bottom=Math.min(bottom,reading.top-rect.top-16);
   else right=Math.min(right,reading.left-rect.left-18);
  }
  if(right-left<48||bottom-top<48)return;
  if(simulation)stopSprings();
  const start=[...camera.box],unitX=start[2]/rect.width,unitY=start[3]/rect.height;
  camera.focus={x:node.x,y:node.y};
  moveTopicCamera([node.x-(left+right)/2*unitX,node.y-(top+bottom)/2*unitY,start[2],start[3]],animate,start);
 });
}
for(const event of ['pointerdown','wheel','keydown'])listen(canvas,event,cancelTopicNavigation,{passive:true});
function chooseTopic(id,fromSidebar=false){
 if(!concept(id))return;
 cancelTopicNavigation();
 const start=[...camera.box];
 options.onTopic(id);options.onSelect(null);
 camera.topic=id;camera.path=[concept(id.split('-')[0])?.name,concept(id)?.name].filter((name,index,names)=>name&&names.indexOf(name)===index);
 if(!graphView())return;
 const sequence=++topicNavigationSequence,manualSequence=topicManualSequence,query=graphQuery(),key=graphKey(query);
 let version=graphSequence;
 const current=()=>sequence===topicNavigationSequence&&manualSequence===topicManualSequence&&camera.topic===id&&graphView()&&options.getState().filters.concept===id&&graphKey(graphQuery())===key&&graphSequence===version;
 const focus=async()=>{
  const root=rootScene;
  const currentScene=()=>current()&&!graphLoading&&root&&rootScene===root&&!root.disposed&&graphKey(root.data.query||{})===key;
  if(!currentScene())return;
  try{
   let node=findTopicNode(id,root);
   if(!node&&id.includes('-')){
    const parent=findTopicNode(id.split('-')[0],root);
    if(parent?.query&&!parent.child){
     const data=await graphRequest(parent.query);
     if(!currentScene())return;
     installChildren([parent],[{data}]);labelsDirty=true;
    }
    node=findTopicNode(id,root);
   }
   if(!currentScene())return;
   if(!node){notice('현재 조건에서 이 주제의 노드를 찾지 못했어요.');return;}
   notice('');if(simulation)stopSprings();pinnedNode=node;
   if(!fromSidebar||node.level==='subtopic')options.onNode(node);
   fitTopicOverview(true,start);
   centeredGraphNode=node;
  }catch(error){if(currentScene())notice(error.message,true);}
 };
 if(!graphLoading&&rootScene&&graphKey(graphData?.query||{})===key)focus();
 else{const request=loadGraph(query);version=graphSequence;request.then(focus).catch(error=>{if(current())notice(error.message,true);});}
}
const graphNodeColors={band:'#8290A8',main:'#5EEAD4',subtopic:'#8BA9D4',topic:'#5EEAD4',source:'#8290A8',dataset:'#8290A8'};
const graphColorKind=n=>['main','subtopic'].includes(n.level)?n.level:n.kind;
const graphRangeColors=['#8bd1ac','#b8d38d','#ccd69b'];
function childZoom(node){
 // The initial taxonomy is already in bootstrap: keep all its branches visible
 // without scheduling source/dataset reads for every subtopic.
 if(node.level==='main'&&node.scene.data.view==='topics_v1'&&overviewGraphs.has(graphKey(node.query||{})))return .30;
 if(!node.scene.parent&&node.kind==='band'&&node.query?.band!=='unclassified')return .45;
 let depth=0;for(let scene=node.scene;scene.parent;scene=scene.parent.scene)depth++;
 if(node.scene.data.view!=='topics_v1'&&node.query?.band!=='unclassified')depth=Math.max(0,depth-1);
 const levels=[4,8,50,300,1250];
 return levels[depth]||1250*5**(depth-levels.length+1);
}
function syncHiddenScene(scene){
 const dx=scene.pendingX||0,dy=scene.pendingY||0;if(!dx&&!dy)return;
 scene.pendingX=scene.pendingY=0;scene.bounds.cx+=dx;scene.bounds.cy+=dy;
 for(const n of scene.nodes){
  if([...n.entity.members].some(member=>member.scene!==scene&&member.scene.active))continue;
  n.x+=dx;n.y+=dy;n.homeX+=dx;n.homeY+=dy;
  if(n.child){n.child.pendingX=(n.child.pendingX||0)+dx;n.child.pendingY=(n.child.pendingY||0)+dy;}
 }
}
function nodeKey(n){
 if(n.kind==='range'||n.kind==='source')return graphKey(n.query||{})+'|'+n.id;
 return (n.scene?.data.query?.band||n.query?.band||'all')+'|'+n.id;
}
function shareNode(n){
 const key=nodeKey(n);let entity=entityNodes.get(key);
 if(!entity){entity={x:n.x,y:n.y,vx:0,vy:0,members:new Set()};entityNodes.set(key,entity);}
 entity.members.add(n);n.entity=entity;
 for(const property of ['x','y','vx','vy'])Object.defineProperty(n,property,{get:()=>entity[property],set:value=>{entity[property]=value;},enumerable:true});
 return n;
}
function sameNode(a,b){return !!a&&!!b&&nodeKey(a)===nodeKey(b);}
function connectedNode(a,b){return [...a.entity.members].some(member=>[...member.neighbors].some(n=>sameNode(n,b)));}
function makeScene(data,bounds,parent=null){
 const scene={data,bounds,parent,nodes:[],edges:[],revealAt:parent?childZoom(parent):0,disposed:false,active:false,displayOpacity:0,lastPaint:performance.now()};
 const merged=data.view==='topics_v1',overview=merged&&!parent&&!data.query?.concept;
 const items=(merged&&data.total===0?[]:(data.nodes||[])).map(n=>merged&&['main','subtopic'].includes(n.level)?{...n,kind:n.level}:n);
 const layoutCount=items.length,offset=data.query?.concept?3:.5,key=graphKey(data.query||{});
 // A single catalogue hub replaces confidence groups. Its edges indicate
 // membership of the displayed catalogue, never a new semantic relation.
 if(overview&&data.total>0)items.push({id:'catalogue:all',kind:'topic',level:'overview',title:Object.values(data.query||{}).some(Boolean)?'검색된 자료':'전체 자료',count:data.total,overviewHub:true});
 scene.nodes=items.map((n,i)=>{
  const angle=i*2.399963,r=n.overviewHub?0:Math.sqrt((i+offset)/Math.max(1,layoutCount+offset))*(overview?.60:merged&&!parent?.70:1);
  const homeX=bounds.cx+bounds.rx*r*Math.cos(angle),homeY=bounds.cy+bounds.ry*r*Math.sin(angle),saved=layoutOffsets.get(key+'|'+n.id);
  const color=n.kind==='range'?graphRangeColors[Math.min(Math.max(0,(n.query?.branch||'').split('.').length-1),graphRangeColors.length-1)]:(graphNodeColors[graphColorKind(n)]||graphNodeColors.topic);
  return shareNode({...n,color,x:homeX+(saved?.x||0)*bounds.rx,y:homeY+(saved?.y||0)*bounds.ry,homeX,homeY,scene,child:null,pending:false,retryAt:0,revealStarted:null,revealDelay:Math.random()*360,revealDuration:180+Math.random()*120,twinkle:Math.random()<.28,twinklePhase:Math.random()*Math.PI*2,twinkleSpeed:.00065+Math.random()*.00065,vx:0,vy:0,sprite:null,button:null,neighbors:new Set()});
 });
 for(const n of scene.nodes){
  const d=scene.nodes.reduce((best,o)=>o===n?best:Math.min(best,Math.hypot(n.homeX-o.homeX,n.homeY-o.homeY)),Infinity);
  n.radius=Math.min(Math.min(bounds.rx,bounds.ry)*.22,Number.isFinite(d)?d*.42:Infinity);
  n.label=n.title.length>48?n.title.slice(0,47)+'…':n.title;
  const subtitle=n.kind==='dataset'?(n.record.publisher||source(n.record.source_id)?.name||''):n.count.toLocaleString('ko-KR')+'건';
  n.subtitle=subtitle.length>38?subtitle.slice(0,37)+'…':subtitle;
  n.titleSize=n.kind==='main'||n.level==='main'||n.overviewHub?16:14;
  paint.font=`600 ${n.titleSize}px ${fontFamily}`;const titleWidth=paint.measureText(n.label).width;
  paint.font=`400 12px ${fontFamily}`;n.labelWidth=Math.ceil(Math.max(titleWidth,paint.measureText(n.subtitle).width)+12);refreshNodeLabel(n);
 }
 const byId=new Map(scene.nodes.map(n=>[n.id,n]));
 const hub=scene.nodes.find(n=>n.overviewHub);
 if(hub)for(const n of scene.nodes)if(n!==hub){scene.edges.push({a:hub,b:n,containment:true});hub.neighbors.add(n);n.neighbors.add(hub);}
 for(const e of data.edges||[]){const a=byId.get(e.a),b=byId.get(e.b);if(a&&b){scene.edges.push({...e,a,b});a.neighbors.add(b);b.neighbors.add(a);}}
 if(parent||data.query?.concept){for(const n of scene.nodes){scene.edges.push({a:parent||{x:bounds.cx,y:bounds.cy,vx:0,vy:0},b:n,containment:true});if(parent){parent.neighbors.add(n);n.neighbors.add(parent);}}}
 if(parent)sceneCache.set(scene,true);
 {const prepared=scene.nodes.filter(n=>n.query&&overviewGraphs.has(graphKey(n.query)));installChildren(prepared,prepared.map(n=>({data:overviewGraphs.get(graphKey(n.query))})));}
 return scene;
}
function inView(x,y,r=0){const [l,t,w,h]=camera.box;return x+r>=l&&x-r<=l+w&&y+r>=t&&y-r<=t+h;}
function sceneInView(scene,unit){
 if(!scene.parent)return true;
 const extent=scene.nodes.reduce((r,n)=>Math.max(r,Math.hypot(n.x-scene.bounds.cx,n.y-scene.bounds.cy)+n.radius),scene.parent.radius);
 return inView(scene.bounds.cx,scene.bounds.cy,extent+60*unit);
}
function releaseScene(scene){
 scene.disposed=true;sceneCache.delete(scene);
 for(const n of scene.nodes){n.entity.members.delete(n);if(!n.entity.members.size)entityNodes.delete(nodeKey(n));for(const other of n.neighbors)other.neighbors.delete(n);}if(pinnedNode?.scene===scene)pinnedNode=null;
 for(const n of scene.nodes){if(n.child){releaseScene(n.child);n.child=null;}scene.parent?.neighbors.delete(n);n.neighbors.clear();n.sprite=null;n.button?.remove();n.button=null;if(hoveredNode===n)hoveredNode=null;if(focusedNode===n)focusedNode=null;}
 if(simulation?.nodes.some(n=>n.scene===scene))stopSprings();
}
function hideScene(scene){
 if(!scene.active)return;scene.active=false;
 for(const n of scene.nodes){n.opacity=0;n.revealStarted=null;n.sprite=null;n.showLabel=false;n.button?.remove();n.button=null;if(hoveredNode===n)hoveredNode=null;if(focusedNode===n)focusedNode=null;if(n.child)hideScene(n.child);}
 if(simulation?.nodes.some(n=>n.scene===scene))stopSprings();
}
function pruneScenes(){
 let count=[...sceneCache.keys()].reduce((sum,s)=>sum+s.nodes.length,0);
 for(const scene of sceneCache.keys()){
  if(sceneCache.size<=80&&count<=3200)break;
  const p=scene.parent,u=camera.box[2]/sceneWidth;
  const preparing=p&&p.opacity>.5&&zoomScale()>=childZoom(p)*.65&&inView(p.x,p.y,p.radius+80*u);
  let selectedBranch=false;for(let ancestor=pinnedNode?.scene;ancestor;ancestor=ancestor.parent?.scene)if(ancestor===scene)selectedBranch=true;
  if(scene.active||p?.pending||preparing||selectedBranch||scene.nodes.some(n=>n.kind==='main'||n.kind==='subtopic'))continue;
  releaseScene(scene);if(scene.parent?.child===scene)scene.parent.child=null;
  count=[...sceneCache.keys()].reduce((sum,s)=>sum+s.nodes.length,0);
 }
}
function expandNode(node){
 if(node.kind==='dataset'||!node.query||node.scene.disposed)return;
 if(node.child){scheduleGraphFrame();return;}
 node.openRequested=true;requestVisibleDetails();
}
function openGraphNode(node){if(!node||node.scene?.disposed)return;cancelTopicNavigation();if(node.level==='main'&&node.scene.data.view==='topics_v1'){chooseTopic(node.query.concept);return;}pinnedNode=pinnedNode===node?null:node;scheduleGraphFrame();if(node.kind==='dataset'){options.onSelect(node.record);scheduleGraphFrame();}else {expandNode(node);options.onNode(node);}centerGraphNode(node);}
function installChildren(nodes,results){
 if(!nodes.length)return;
 const readyAt=performance.now();
  for(let i=0;i<nodes.length;i++){
   const n=nodes[i],result=results[i];if(n.scene.disposed||n.child||!result)continue;
   if(result.error){n.retryAt=readyAt+10000;if(n.openRequested)notice(result.error.message,true);continue;}
   const child=makeScene(result.data,{cx:n.x,cy:n.y,rx:n.radius*1.6,ry:n.radius*1.6},n);n.child=child;
   n.openRequested=false;
  }
}
async function requestVisibleDetails(){
 if(!graphView()||graphLoading)return;
 const ready=sceneNodes.filter(n=>!n.child&&n.query&&overviewGraphs.has(graphKey(n.query)));
 if(ready.length){installChildren(ready,ready.map(n=>({data:overviewGraphs.get(graphKey(n.query))})));labelsDirty=true;scheduleGraphFrame();}
 if(detailBatch||simulation||pointer?.moved)return;
 const u=camera.box[2]/sceneWidth,cx=camera.focus?Math.max(camera.box[0],Math.min(camera.box[0]+camera.box[2],camera.focus.x)):camera.box[0]+camera.box[2]/2,cy=camera.focus?Math.max(camera.box[1],Math.min(camera.box[1]+camera.box[3],camera.focus.y)):camera.box[1]+camera.box[3]/2;
 const eligible=sceneNodes.filter(n=>n.opacity>.5&&n.query&&n.kind!=='dataset'&&(n.openRequested||zoomScale()>=childZoom(n)*.65)&&inView(n.x,n.y,n.radius+80*u));
 eligible.sort((a,b)=>Number(!!b.openRequested)-Number(!!a.openRequested)||childZoom(b)-childZoom(a)||Math.hypot(a.x-cx,a.y-cy)-Math.hypot(b.x-cx,b.y-cy));
 if(!eligible.length){pruneScenes();return;}
 const remaining=eligible.filter(n=>!n.child&&!n.pending),now=performance.now();
 const readyToLoad=remaining.filter(n=>n.retryAt<=now);
 if(!readyToLoad.length){
  const retryAt=Math.min(...remaining.map(n=>n.retryAt));
  if(Number.isFinite(retryAt))queueGraphDetails(Math.max(80,retryAt-now));
  pruneScenes();return;
 }
 const nodes=readyToLoad.filter(n=>childZoom(n)===childZoom(readyToLoad[0])).slice(0,32),origin=rootScene;
 const batch={origin,nodes};detailBatch=batch;
 for(const n of nodes)n.pending=true;
 const results=new Array(nodes.length);let next=0;
 // Reveal each completed branch without waiting for slower requests.
 async function worker(){
  while(next<nodes.length&&rootScene===origin){const i=next++,n=nodes[i];pendingDetails++;
   try{results[i]={data:await graphRequest(n.query)};}catch(error){results[i]={error};}finally{pendingDetails--;}
   if(rootScene===origin&&!origin.disposed){installChildren([n],[results[i]]);labelsDirty=true;scheduleGraphFrame();}
  }
 }
 try{
  await Promise.all(Array.from({length:Math.min(6,nodes.length)},worker));
  if(rootScene!==origin||origin.disposed)return;
  labelsDirty=true;scheduleGraphFrame();pruneScenes();
 }finally{
  for(const n of nodes)n.pending=false;
  if(detailBatch===batch)detailBatch=null;
  queueGraphDetails();
 }
}
function queueGraphDetails(delay=80){
 const due=performance.now()+delay;if(detailTimer&&detailDue<=due)return;
 clearTimeout(detailTimer);detailDue=due;
 detailTimer=setTimeout(()=>{detailTimer=null;detailDue=0;labelsDirty=true;scheduleGraphFrame();requestVisibleDetails();},delay);
}
function makeLabelSprite(n){
 const display=refreshNodeLabel(n);const c=document.createElement('canvas'),ratio=pixelRatio;c.width=Math.ceil(n.labelWidth*ratio);c.height=Math.ceil(44*ratio);
 const p=c.getContext('2d',{willReadFrequently:true});p.scale(ratio,ratio);p.textAlign='center';p.lineJoin='round';p.lineWidth=3;p.strokeStyle='#0a1021';
 p.font=`600 ${n.titleSize}px ${fontFamily}`;p.strokeText(display.label,n.labelWidth/2,18);const colorKind=graphColorKind(n);p.fillStyle=n.color!==graphNodeColors[colorKind]?n.color:colorKind==='main'||n.overviewHub?'#BBF7E8':colorKind==='subtopic'?'#C5D5EA':n.color;p.fillText(display.label,n.labelWidth/2,18);
 p.font=`400 12px ${fontFamily}`;p.strokeText(display.subtitle,n.labelWidth/2,34);p.fillStyle='#c1cbdc';p.fillText(display.subtitle,n.labelWidth/2,34);
 n.sprite=c;n.spriteRatio=ratio;
}
function arrangeLabels(){
 const boxes=[];
 const selected=camera.topic?findTopicNode(camera.topic):null;
 const family=new Set(selected?[selected,...(selected.level==='main'?selected.child?.nodes||[]:[])]:[]);
 const priority=n=>sameNode(n,selected)?-2:family.has(n)?-1:n.kind==='main'||n.level==='main'?0:n.overviewHub?1:n.kind==='subtopic'||n.level==='subtopic'?2:3;
 // Keep the same star positions. Place major-topic labels first, shifting only
 // their text when necessary; smaller screens can explore every name via the sidebar.
 const ordered=[...graphNodes].sort((a,b)=>priority(a)-priority(b));
 const sidebar=document.querySelector('.sidebar')?.getBoundingClientRect();
 const left=sceneWidth<700?8:(sidebar?.right||318)-graphRect.left+8;
 for(const n of ordered){
  n.labelOffsetX=0;n.labelOffsetY=7;n.showLabel=false;
  if(n.opacity<=.5)continue;
  const offsets=priority(n)<2?[[0,7],[0,-45],[n.labelWidth/2+14,-18],[-n.labelWidth/2-14,-18],[0,34],[0,-72]]:[[0,7]];
  for(const [dx,dy] of offsets){
   const box={left:n.sx-n.labelWidth/2+dx,right:n.sx+n.labelWidth/2+dx,top:n.sy+dy,bottom:n.sy+dy+40};
   if(box.left<left||box.right>sceneWidth-8||box.top<0||box.bottom>graphRect.height-10)continue;
   if(state.selected?.id!==n.id&&boxes.some(b=>box.left<b.right+8&&box.right>b.left-8&&box.top<b.bottom+6&&box.bottom>b.top-6))continue;
   n.labelOffsetX=dx;n.labelOffsetY=dy;n.showLabel=true;boxes.push(box);break;
  }
  if(n.showLabel&&(!n.sprite||n.spriteRatio!==pixelRatio))makeLabelSprite(n);
 }
 labelsDirty=false;
 const accessible=$('#graph-accessibility'),wanted=new Set(graphNodes.filter(n=>n.opacity>interactiveOpacity));
 for(const button of [...accessible.children])if(!wanted.has(button.graphNode)){button.graphNode.button=null;button.remove();}
 for(const n of wanted){if(n.button)continue;const b=document.createElement('button');b.type='button';b.textContent=nodeAccessibleTitle(n);b.graphNode=n;n.button=b;
  b.onclick=()=>openGraphNode(n);b.onfocus=()=>{focusedNode=n;scheduleGraphFrame();};b.onblur=()=>{focusedNode=null;scheduleGraphFrame();};accessible.append(b);}
}
function starSizeFor(n){
 if(n.kind==='main'||n.level==='main')return sceneWidth<700?64:70;
 if(n.kind==='subtopic'||n.level==='subtopic')return sceneWidth<700?36:44;
 if(n.kind==='topic')return sceneWidth<700?32:44;
 if(n.kind==='band')return 64;
 if(n.kind==='source')return 34;
 if(n.kind==='dataset')return 18;
 const depth=(n.query?.branch||'').split('.').length;
 return 20+12/2**depth;
}
function starSprite(color,flare=false,tinted=false){
 const key=color+(flare?':flare':':glow')+(tinted?':tinted':'');if(starSprites.has(key))return starSprites.get(key);
 const sprite=document.createElement('canvas');sprite.width=sprite.height=96;
 const p=sprite.getContext('2d'),rgb=[1,3,5].map(i=>parseInt(color.slice(i,i+2),16)).join(',');
 const glow=p.createRadialGradient(48,48,0,48,48,46);
 glow.addColorStop(0,tinted?color:'#ffffff');glow.addColorStop(.045,tinted?color:'#ffffff');glow.addColorStop(.09,`rgba(${rgb},1)`);glow.addColorStop(flare?.2:.17,`rgba(${rgb},${flare?.45:.28})`);glow.addColorStop(flare?.48:.32,`rgba(${rgb},${flare?.08:.035})`);glow.addColorStop(flare?1:.6,`rgba(${rgb},0)`);
 p.fillStyle=glow;p.fillRect(0,0,96,96);
 if(flare){p.translate(48,48);p.fillStyle=tinted?`rgba(${rgb},.45)`:'rgba(240,247,255,.85)';p.beginPath();p.moveTo(0,-33);p.lineTo(2,-3);p.lineTo(25,0);p.lineTo(2,3);p.lineTo(0,33);p.lineTo(-2,3);p.lineTo(-25,0);p.lineTo(-2,-3);p.closePath();p.fill();}
 starSprites.set(key,sprite);return sprite;
}
function renderSpaceLight(now,context=starPaint){
 for(const star of spaceTwinkles){
  const pulse=Math.pow((Math.sin(now*star.speed+star.phase)+1)*.5,80);
  if(pulse<.04)continue;
  const {x,y}=spaceStarPosition(star),size=6+star.r*3;
  if(x<0||y<0||x>graphRect.width||y>graphRect.height)continue;
  context.globalAlpha=pulse*.3;
  context.drawImage(starSprite(star.color,true),x-size/2,y-size/2,size,size);
 }
 // Only one short, faint meteor; postpone it while the graph is being manipulated.
 const busy=pointer||simulation||now<movingUntil;
 if(!spaceMeteor&&now>=nextSpaceMeteor&&!busy){
  spaceMeteor={start:now,x:graphRect.width*(.25+Math.random()*.5),y:graphRect.height*(.08+Math.random()*.35)};
  nextSpaceMeteor=now+30000+Math.random()*45000;
 }
 if(spaceMeteor){
  const t=(now-spaceMeteor.start)/1100;
  if(t>=1||busy){spaceMeteor=null;return;}
  const x=spaceMeteor.x+t*150,y=spaceMeteor.y+t*85;
  const tail=context.createLinearGradient(x-48,y-27,x,y);
  tail.addColorStop(0,'rgba(170,200,255,0)');tail.addColorStop(1,'rgba(220,233,255,.38)');
  context.globalAlpha=Math.sin(Math.PI*t);context.strokeStyle=tail;context.lineWidth=.8;
  context.beginPath();context.moveTo(x-48,y-27);context.lineTo(x,y);context.stroke();
 }
}
function renderStarLight(){
 starPaint.setTransform(pixelRatio,0,0,pixelRatio,0,0);starPaint.clearRect(0,0,graphRect.width,graphRect.height);
 cosmosLightPaint.setTransform(pixelRatio,0,0,pixelRatio,0,0);cosmosLightPaint.clearRect(0,0,graphRect.width,graphRect.height);
 if(reducedGraphMotion||document.hidden)return;
 const now=performance.now();renderSpaceLight(now,graphView()?starPaint:cosmosLightPaint);
 cosmosLightPaint.globalAlpha=1;
 if(!graphView())return;
 for(const n of starsForFrame){
  const pulse=Math.pow((Math.sin(now*n.twinkleSpeed+n.twinklePhase)+1)*.5,8);
  if(pulse<.015)continue;
  const size=starSizeFor(n)*1.18*(1+pulse*.1);
  starPaint.globalAlpha=n.starAlpha*pulse*.6;
  starPaint.drawImage(starSprite(n.starColor||n.color,true,true),n.sx-size/2,n.sy-size/2,size,size);
 }
 // The animated light canvas sits above the graph; keep label areas transparent.
 const active=focusedNode||hoveredNode||pinnedNode;
 for(const n of graphNodes)if((n.showLabel||sameNode(active,n)||state.selected?.id===n.id)&&n.sprite)
  starPaint.clearRect(Math.round(n.sx-n.labelWidth/2+(n.labelOffsetX||0)),Math.round(n.sy+(n.labelOffsetY??7)),n.labelWidth,44);
 starPaint.globalAlpha=1;
}
function scheduleStarLight(){
 if(starTimer||reducedGraphMotion||document.hidden)return;
 starTimer=setTimeout(()=>{starTimer=null;renderStarLight();scheduleStarLight();},50);
}
listen(document,'visibilitychange',()=>{clearTimeout(starTimer);starTimer=null;renderStarLight();scheduleStarLight();});
function renderGraph(displayOnly=false){
 displayOnly=displayOnly===true;if(displayOnly&&!rootScene)return;
 if(!graphView()){
  sizeScene();
  if(cosmosCanvas.width!==canvas.width||cosmosCanvas.height!==canvas.height){cosmosCanvas.width=cosmosLight.width=canvas.width;cosmosCanvas.height=cosmosLight.height=canvas.height;}
  cosmosPaint.setTransform(pixelRatio,0,0,pixelRatio,0,0);cosmosPaint.globalAlpha=1;
  cosmosPaint.drawImage(spaceCanvas,0,0,graphRect.width,graphRect.height);paintSpaceStars(cosmosPaint);
  renderStarLight();scheduleStarLight();return;
 }
 if(!sceneWidth)sizeScene();if(!sceneWidth)return;
 const now=performance.now();if(simulation&&!displayOnly)stepSprings(Math.min((now-lastFrameTime)/1000||1/60,1/30));lastFrameTime=now;
 if(!rootScene||rootScene.data!==graphData){
  if(displayOnly)return;
  if(rootScene)releaseScene(rootScene);
  const mobile=sceneWidth<700,left=(mobile?40:285)*1200/sceneWidth,right=1200-65*1200/sceneWidth,top=160*1200/sceneWidth,bottom=sceneHeight-130*1200/sceneWidth;
  rootScene=makeScene(graphData||{nodes:[],edges:[]},{cx:(left+right)/2,cy:(top+bottom)/2,rx:Math.max(40,(right-left)*.62),ry:Math.max(40,(bottom-top)*.62)});labelsDirty=true;queueGraphDetails();
 }
 const u=camera.box[2]/sceneWidth,scenes=[];let fading=false;graphNodes=[];sceneNodes=[];const visibleEntities=new Map();
 function visit(s,opacity=1){
  if(s.parent){
   if(zoomScale()<=s.revealAt){s.displayOpacity=0;s.lastPaint=now;hideScene(s);return;}
   if(!displayOnly)syncHiddenScene(s);
   const target=sceneInView(s,u)?Math.min(1,Math.max(0,zoomScale()/s.revealAt-.8)):0;
   const dt=Math.min(32,Math.max(1,now-s.lastPaint));s.lastPaint=now;
   const previous=s.displayOpacity;
   s.displayOpacity=reducedGraphMotion?target:s.displayOpacity+(target-s.displayOpacity)*(1-Math.exp(-dt/55));
   if(Math.abs(target-s.displayOpacity)<.01)s.displayOpacity=target;else fading=true;
   if((previous>.5)!==(s.displayOpacity>.5))labelsDirty=true;
   opacity*=s.displayOpacity;
   if(opacity<.005){hideScene(s);return;}
   sceneCache.delete(s);sceneCache.set(s,true);
  }
  s.active=true;
  scenes.push(s);
  for(const n of s.nodes){
   n.sx=(n.x-camera.box[0])/u;n.sy=(n.y-camera.box[1])/u;
   if(n.revealStarted===null)n.revealStarted=now;
   const progress=reducedGraphMotion?1:Math.min(1,Math.max(0,(now-n.revealStarted-n.revealDelay)/n.revealDuration));
   const previous=n.opacity||0;n.opacity=opacity*progress*progress*(3-2*progress);
   if(progress<1)fading=true;
   if((previous>.5)!==(n.opacity>.5)||(previous>interactiveOpacity)!==(n.opacity>interactiveOpacity))labelsDirty=true;
   if(inView(n.x,n.y,60*u)){sceneNodes.push(n);const key=nodeKey(n),old=visibleEntities.get(key);if(!old||n.opacity>old.opacity)visibleEntities.set(key,n);}else{n.sprite=null;n.button?.remove();n.button=null;n.showLabel=false;}
   if(n.child)visit(n.child,n.opacity);
  }
 }
 visit(rootScene);
 const resolvedEdges=[],edgeKeys=new Set();
 function keepVisible(n,opacity){
  const key=nodeKey(n),previous=n.opacity||0;
  n.opacity=Math.max(n.opacity||0,opacity);n.sx=(n.x-camera.box[0])/u;n.sy=(n.y-camera.box[1])/u;
  if(inView(n.x,n.y,60*u))visibleEntities.set(key,n);
  if(previous!==n.opacity||!n.sprite)labelsDirty=true;
 }
 if(pinnedNode&&!pinnedNode.scene.disposed)keepVisible(pinnedNode,1);
 const relationScenes=new Set(scenes);
 if(pinnedNode?.kind==='dataset')relationScenes.add(pinnedNode.scene);
 for(const s of relationScenes){
  for(const raw of s.data.edges||[]){
   const band=s.data.query?.band||'all',aKey=band+'|'+raw.a,bKey=band+'|'+raw.b;
   const a=entityNodes.get(aKey),b=entityNodes.get(bKey);if(!a||!b)continue;
   const selected=pinnedNode&&nodeKey(pinnedNode)===aKey;
   const an=selected?pinnedNode:visibleEntities.get(aKey);
   const bn=visibleEntities.get(bKey)||[...b.members].find(n=>!n.scene.disposed);
   if(an?.kind==='dataset'&&an.opacity>0&&bn?.kind==='subtopic'){
    keepVisible(bn,selected?1:an.opacity);
    resolvedEdges.push({...raw,a:an,b:bn});an.neighbors.add(bn);bn.neighbors.add(an);
   }
  }
 }
 graphNodes=[...visibleEntities.values()];
 const busy=!displayOnly&&(now<movingUntil||!!simulation);
 if(labelsDirty&&!busy)arrangeLabels();
 paint.setTransform(pixelRatio,0,0,pixelRatio,0,0);paint.globalAlpha=1;paint.drawImage(spaceCanvas,0,0,graphRect.width,graphRect.height);paintSpaceStars();
 const active=pinnedNode||hoveredNode||focusedNode;
 paint.lineWidth=1.1;
 // Quiet, straight connections keep each topic family legible.
 paint.lineWidth=.6;paint.setLineDash([]);
 for(const s of [...scenes,{edges:resolvedEdges}]){
  for(const e of s.edges){
   const edgeKey=[nodeKey(e.a),nodeKey(e.b)].sort().join('|');if(edgeKeys.has(edgeKey))continue;edgeKeys.add(edgeKey);
   const a=e.a,b=e.b;if(!inView(a.x,a.y,60*u)&&!inView(b.x,b.y,60*u))continue;
   const near=active&&(sameNode(a,active)||sameNode(b,active)),alpha=Math.min(a.opacity??b.opacity,b.opacity);
   paint.globalAlpha=alpha*(active?(near?.10:.025):.07);paint.strokeStyle=near?(b.color||a.color||'#95a7c0'):'#95a7c0';
   paint.beginPath();paint.moveTo((a.x-camera.box[0])/u,(a.y-camera.box[1])/u);
   paint.lineTo((b.x-camera.box[0])/u,(b.y-camera.box[1])/u);paint.stroke();
  }
 }
 paint.setLineDash([]);
 for(const n of graphNodes){
  const selected=state.selected?.id===n.id,lit=sameNode(active,n)||selected,dim=active&&!sameNode(active,n)&&!connectedNode(active,n);
  n.starAlpha=n.opacity*(n.scoreAlpha??1)*(dim?.25:1);paint.globalAlpha=n.starAlpha;
  const starSize=starSizeFor(n);
  n.starColor=lit?'#F6C76B':n.color;
  paint.drawImage(starSprite(n.starColor,false,true),n.sx-starSize/2,n.sy-starSize/2,starSize,starSize);
 }
 // Finish every star before drawing labels so neighbouring glows cannot erase text.
 for(const n of graphNodes){
  const lit=sameNode(active,n)||state.selected?.id===n.id;
  if((n.showLabel||lit)&&n.sprite){paint.globalAlpha=n.starAlpha;paint.drawImage(n.sprite,Math.round(n.sx-n.labelWidth/2+(n.labelOffsetX||0)),Math.round(n.sy+(n.labelOffsetY??7)),n.labelWidth,44);}
 }
 paint.globalAlpha=1;
 if(!rootScene.nodes.length){paint.fillStyle='#a0a2b1';paint.font=`13px ${fontFamily}`;paint.textAlign='center';paint.fillText(ct(graphData?'검색 결과 없음':'연결 지도를 불러오는 중…'),graphRect.width/2,graphRect.height/2);}
 const percent=cn(Math.round(zoomScale()*100))+'%';if($('#zoom-value').textContent!==percent)$('#zoom-value').textContent=percent;
 options.onCaption(graphCaption());
 const legend=ct('주제를 선택해 이동하고 세부 자료를 탐색하세요');if($('.graph-legend span').textContent!==legend)$('.graph-legend span').textContent=legend;
 starsForFrame=graphNodes.filter(n=>n.twinkle&&n.starAlpha>.025);renderStarLight();scheduleStarLight();
 if(!displayOnly){if(simulation||fading)scheduleGraphFrame();else if(labelsDirty)queueGraphDetails();}
}
function scheduleGraphFrame(){if(!zoomFrame)zoomFrame=requestAnimationFrame(()=>{zoomFrame=0;renderGraph();});}
function applyBox(){labelsDirty=true;scheduleGraphFrame();queueGraphDetails();}
function zoom(factor,anchor){
 cancelTopicNavigation();
 if(simulation)stopSprings();
 const old=camera.box,p=anchor||{x:old[0]+old[2]/2,y:old[1]+old[3]/2},w=Math.max(1e-7,Math.min(2000,old[2]*factor)),h=old[3]*w/old[2];
 camera.focus=p;camera.box=[p.x-(p.x-old[0])*w/old[2],p.y-(p.y-old[1])*h/old[3],w,h];movingUntil=performance.now()+140;applyBox();
}
function graphPoint(x,y){return{x:camera.box[0]+(x-graphRect.left)/graphRect.width*camera.box[2],y:camera.box[1]+(y-graphRect.top)/graphRect.height*camera.box[3]};}
function hitNode(x,y){const sx=x-graphRect.left,sy=y-graphRect.top;let best=null,distance=14;for(const n of graphNodes){if(n.opacity<=interactiveOpacity)continue;const d=Math.hypot(n.sx-sx,n.sy-sy);if(d<distance){best=n;distance=d;}}return best;}
function moveNode(n,dx,dy){
 n.x+=dx;n.y+=dy;
 for(const member of n.entity.members)if(member.child&&!member.child.active){member.child.pendingX=(member.child.pendingX||0)+dx;member.child.pendingY=(member.child.pendingY||0)+dy;}
}
function startSprings(n){
 // Include nearby unlinked nodes too: proximity creates contact, not a data relationship.
 const nodes=graphNodes.filter(x=>x.opacity>interactiveOpacity&&!x.scene.disposed);if(!nodes.includes(n))nodes.push(n);
 const index=new Map(nodes.map((x,i)=>[nodeKey(x),i])),rest=nodes.map(x=>({x:x.x,y:x.y})),links=[];
 for(let i=0;i<nodes.length;i++)for(const other of new Map([...nodes[i].entity.members].flatMap(member=>[...member.neighbors]).map(other=>[nodeKey(other),other])).values()){const j=index.get(nodeKey(other));if(j>i)links.push({i,j,distance:Math.hypot(other.x-nodes[i].x,other.y-nodes[i].y)});}
 const degrees=nodes.map(()=>0);for(const {i,j} of links){degrees[i]++;degrees[j]++;}
 for(const link of links)link.strength=12/Math.sqrt(Math.max(1,degrees[link.i],degrees[link.j]));
 simulation={nodes,rest,links,dragged:n,target:{x:n.x,y:n.y},releasedAt:null};lastFrameTime=performance.now();
}
function nearbyPairs(nodes,cellSize,visit){
 const grid=new Map();
 for(let i=0;i<nodes.length;i++){
  const n=nodes[i],cx=Math.floor(n.x/cellSize),cy=Math.floor(n.y/cellSize);
  for(let x=cx-1;x<=cx+1;x++)for(let y=cy-1;y<=cy+1;y++)for(const j of grid.get(x+':'+y)||[])visit(j,i);
  const key=cx+':'+cy;if(!grid.has(key))grid.set(key,[]);grid.get(key).push(i);
 }
}
function collisionRadius(n){return(n.kind==='dataset'?2.4:5.3)+4;}
function separateNodes(sim,u){
 const {nodes,dragged}=sim;
 for(let pass=0;pass<3;pass++)nearbyPairs(nodes,20*u,(i,j)=>{
  const a=nodes[i],b=nodes[j],radius=(collisionRadius(a)+collisionRadius(b))*u;
  let dx=b.x-a.x,dy=b.y-a.y,d=Math.hypot(dx,dy);if(d>=radius)return;
  if(d<1e-9*u){const angle=(i+1)*2.399963+j;dx=Math.cos(angle);dy=Math.sin(angle);d=1;}else{dx/=d;dy/=d;}
  const distance=Math.hypot(b.x-a.x,b.y-a.y),overlap=radius-distance;
  const wa=a===dragged?.35:1,wb=b===dragged?.35:1,total=wa+wb;
  moveNode(a,-dx*overlap*wa/total,-dy*overlap*wa/total);moveNode(b,dx*overlap*wb/total,dy*overlap*wb/total);
  // Transfer normal momentum, so contact pushes the other node instead of passing through.
  const approaching=(b.vx-a.vx)*dx+(b.vy-a.vy)*dy;
  if(approaching<0){const impulse=-approaching/total;a.vx-=impulse*dx*wa;a.vy-=impulse*dy*wa;b.vx+=impulse*dx*wb;b.vy+=impulse*dy*wb;}
 });
}
function stopSprings(){
 if(!simulation)return;
 for(const n of simulation.nodes){n.vx=0;n.vy=0;if(!n.scene.disposed)saveNodePosition(n);}
 simulation=null;labelsDirty=true;queueGraphDetails();
}
function stepSprings(dt){
 const sim=simulation;if(!sim)return;
 const {nodes,rest,links,dragged,target}=sim,u=camera.box[2]/sceneWidth;
 if(reducedGraphMotion){separateNodes(sim,u);return;}
 const elapsed=sim.releasedAt===null?0:performance.now()-sim.releasedAt,cooling=Math.exp(-elapsed/750);
 const steps=Math.max(1,Math.ceil(dt*180)),step=dt/steps;let speed=0;
 for(let tick=0;tick<steps;tick++){
  const forces=nodes.map((n,i)=>{const strength=n===dragged?0:.65*cooling;return{x:(rest[i].x-n.x)*strength,y:(rest[i].y-n.y)*strength};});
  // Springs constrain distance, not direction; branches can rotate and deform independently.
  for(const {i,j,distance,strength} of links){
   const dx=nodes[j].x-nodes[i].x,dy=nodes[j].y-nodes[i].y,d=Math.hypot(dx,dy);if(d<1e-9*u)continue;
   const stretch=Math.max(0,d-distance)/Math.max(distance,36*u);
   const f=(d-distance)*strength*(1+Math.min(2,stretch*stretch*.7))*cooling/d;forces[i].x+=dx*f;forces[i].y+=dy*f;forces[j].x-=dx*f;forces[j].y-=dy*f;
  }
  nearbyPairs(nodes,48*u,(i,j)=>{
   const a=nodes[i],b=nodes[j],dx=b.x-a.x,dy=b.y-a.y,d=Math.hypot(dx,dy);if(d<1e-9*u||d>=48*u)return;
   const f=900*u*(1-d/(48*u))**2*cooling/d;
   forces[i].x-=dx*f;forces[i].y-=dy*f;forces[j].x+=dx*f;forces[j].y+=dy*f;
  });
  speed=0;
  for(let i=0;i<nodes.length;i++){
   const n=nodes[i],held=n===dragged;
   if(held){forces[i].x+=(target.x-n.x)*160;forces[i].y+=(target.y-n.y)*160;}
   const damping=Math.exp(-(held?25:6)*step);
   n.vx=(n.vx+forces[i].x*step)*damping;n.vy=(n.vy+forces[i].y*step)*damping;
   const v=Math.hypot(n.vx,n.vy),limit=900*u;if(v>limit){n.vx*=limit/v;n.vy*=limit/v;}
   moveNode(n,n.vx*step,n.vy*step);
  }
  separateNodes(sim,u);
  for(const n of nodes)speed=Math.max(speed,Math.hypot(n.vx,n.vy)/u);
 }
 if(!dragged&&(elapsed>4000||(elapsed>350&&speed<.4)))stopSprings();
}
function saveNodePosition(n){
 const key=graphKey(n.scene.data.query||{})+'|'+n.id;layoutOffsets.delete(key);layoutOffsets.set(key,{x:(n.x-n.homeX)/n.scene.bounds.rx,y:(n.y-n.homeY)/n.scene.bounds.ry});
}
listen(canvas,'wheel',e=>{e.preventDefault();const d=e.deltaY*(e.deltaMode===1?16:e.deltaMode===2?500:1);zoom(Math.exp(Math.max(-120,Math.min(120,d))*.003),graphPoint(e.clientX,e.clientY));},{passive:false});
listen(canvas,'pointerdown',e=>{
 if(e.button!==0)return;const n=hitNode(e.clientX,e.clientY),p=graphPoint(e.clientX,e.clientY);
 pointer={id:e.pointerId,x:e.clientX,y:e.clientY,box:[...camera.box],node:n,offset:n?{x:n.x-p.x,y:n.y-p.y}:null,moved:false};canvas.setPointerCapture(e.pointerId);canvas.focus({preventScroll:true});
});
listen(canvas,'pointermove',e=>{
 if(!pointer){const n=hitNode(e.clientX,e.clientY);if(n!==hoveredNode){hoveredNode=n;canvas.title=n?.title||'';canvas.style.cursor=n?'pointer':'grab';scheduleGraphFrame();}return;}
 if(e.pointerId!==pointer.id)return;
 if(!pointer.moved&&Math.hypot(e.clientX-pointer.x,e.clientY-pointer.y)<3)return;
 if(!pointer.moved){pointer.moved=true;if(pointer.node)startSprings(pointer.node);}
 const n=pointer.node;
 if(n){if(!simulation||simulation.dragged!==n)startSprings(n);const p=graphPoint(e.clientX,e.clientY);simulation.target={x:p.x+pointer.offset.x,y:p.y+pointer.offset.y};if(reducedGraphMotion){moveNode(n,simulation.target.x-n.x,simulation.target.y-n.y);separateNodes(simulation,camera.box[2]/sceneWidth);}}
 else{camera.focus=null;camera.box[0]=pointer.box[0]-(e.clientX-pointer.x)*pointer.box[2]/graphRect.width;camera.box[1]=pointer.box[1]-(e.clientY-pointer.y)*pointer.box[3]/graphRect.height;}
 canvas.style.cursor='grabbing';movingUntil=performance.now()+140;applyBox();
});
function finishPointer(e){
 if(!pointer||e.pointerId!==pointer.id)return;const p=pointer;pointer=null;
 if(simulation?.dragged){simulation.dragged=null;simulation.target=null;simulation.releasedAt=performance.now();if(reducedGraphMotion)stopSprings();else scheduleGraphFrame();}
 if(p.moved&&p.node)saveNodePosition(p.node);
 if(!p.moved&&e.type==='pointerup'){if(p.node)openGraphNode(p.node);else{pinnedNode=null;scheduleGraphFrame();}}
 if(canvas.hasPointerCapture(e.pointerId))canvas.releasePointerCapture(e.pointerId);canvas.style.cursor='grab';queueGraphDetails();
}
for(const event of ['pointerup','pointercancel','lostpointercapture'])listen(canvas,event,finishPointer);
listen(canvas,'pointerleave',()=>{if(!pointer){hoveredNode=null;canvas.title='';scheduleGraphFrame();}});
listen(canvas,'keydown',e=>{if(e.key==='Escape'){pinnedNode=null;scheduleGraphFrame();}if(['+','=','-','0','ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)){e.preventDefault();if(e.key==='+'||e.key==='=')zoom(.78);else if(e.key==='-')zoom(1/.78);else if(e.key==='0')resetMap();else{const step=camera.box[2]*.08;camera.box[0]+=e.key==='ArrowLeft'?-step:e.key==='ArrowRight'?step:0;camera.box[1]+=e.key==='ArrowUp'?-step:e.key==='ArrowDown'?step:0;movingUntil=performance.now()+140;applyBox();}}});

/* Temporarily reveal stored branches in the original catalogue canvas. */
const CatalogueGraphFocus = (() => {
  'use strict';
  const topicID=value=>typeof value==='string'&&/^M\d{2,4}(?:-S\d{2,4})?$/.test(value);
  const score=value=>Number.isFinite(value)&&Math.abs(value)<=1;
  function mount({host}) {
    const i18n=catalogueI18n;
    const t=(text,params={})=>i18n?.text(text,params)||text.replace(/\{(\w+)\}/g,(_,key)=>params[key]??'');
    const bind=(node,text,params={})=>{if(i18n)i18n.bind(node,text,params);else node.textContent=t(text,typeof params==='function'?params():params);};
    const status=document.createElement('div');status.id='catalogue-camera-status';status.hidden=true;
    const label=document.createElement('span');label.setAttribute('role','status');
    const resetButton=document.createElement('button');resetButton.type='button';bind(resetButton,'전체 보기');
    status.append(label,resetButton);host.append(status);
    let generation=0,frame=0,patch=null;
    const nativeRender=renderGraph;
    renderGraph=function(...args){
      const result=nativeRender.apply(this,args);
      if(patch&&(rootScene!==patch.root||patch.root.disposed)){cancel();}
      if(patch){const legend=document.querySelector('.graph-legend span');if(legend)legend.textContent=t('금색: 질문 개념 · 파랑: 관련 개념');}
      return result;
    };
    if(typeof arrangeLabels==='function'){
      const nativeLabels=arrangeLabels;
      arrangeLabels=function(...args){
        if(!patch)return nativeLabels.apply(this,args);
        const selected=node=>patch.focusNodes.has(node)||node.entity&&patch.focusEntities.has(node.entity);
        // Native labels otherwise give the first root/main nodes every free slot.
        graphNodes.sort((a,b)=>Number(selected(b))-Number(selected(a))||Number(a.kind==='dataset')-Number(b.kind==='dataset'));
        for(const node of graphNodes){
          if(!patch.scoreAlphas.has(node))patch.scoreAlphas.set(node,node.scoreAlpha);
          node.scoreAlpha=selected(node)?1:Math.min(node.scoreAlpha??1,.08);
        }
        const result=nativeLabels.apply(this,args);
        for(const node of graphNodes){
          if(!selected(node))node.showLabel=false;
          else if((node.kind==='subtopic'||node.level==='subtopic')&&node.opacity>.5){node.showLabel=true;if(!node.sprite)makeLabelSprite(node);}
        }
        return result;
      };
    }
    const sceneTree=scene=>scene?[scene,...scene.nodes.flatMap(node=>sceneTree(node.child))]:[];
    function restore(){
      if(!patch)return;
      for(const [node,position] of patch.positions)Object.assign(node,position);
      for(const [node,value] of patch.scoreAlphas)node.scoreAlpha=value;
      for(const edge of patch.edges){const index=patch.root.edges.indexOf(edge);if(index>=0)patch.root.edges.splice(index,1);edge.a.neighbors.delete(edge.b);edge.b.neighbors.delete(edge.a);}
      for(const {node,original,replacement,cached} of patch.children){
        if(!replacement.disposed)releaseScene(replacement);
        if(node.scene.disposed){if(original&&!original.disposed)releaseScene(original);continue;}
        if(node.child===replacement)node.child=original;
        if(original&&!original.disposed){for(const child of original.nodes){node.neighbors.add(child);child.neighbors.add(node);}for(const scene of cached)sceneCache.set(scene,true);}
      }
      for(const [scene,revealAt] of patch.reveals)if(!scene.disposed)scene.revealAt=revealAt;
      for(const [node,properties] of patch.nodes)if(!node.scene.disposed)Object.assign(node,properties,{sprite:null});
      if(state.selectedRecord&&patch.datasetIDs.has(state.selectedRecord.id)){options.onSelect(null);}
      patch=null;labelsDirty=true;scheduleGraphFrame();
    }
    function cancel(restoreGraph=true){
      generation++;cancelAnimationFrame(frame);frame=0;
      if(restoreGraph){restore();status.hidden=true;}
    }
    function reset(){cancel();resetMap(false);if(typeof fitTopicOverview==='function')fitTopicOverview(true);}
    listen(resetButton,'click',reset);
    // A plain click still opens the selected dataset; actual navigation clears the overlay.
    listen(canvas,'pointerdown',()=>cancel(false));
    listen(canvas,'pointermove',()=>{if(pointer?.moved)cancel();});
    for(const event of ['wheel','keydown'])listen(canvas,event,()=>cancel());
    for(const selector of ['.filters','.sidebar','.zoom']){
      const control=document.querySelector(selector);
      for(const event of ['pointerdown','input','change'])listen(control,event,()=>cancel());
    }
    const current=(sequence,root,version)=>sequence===generation&&rootScene===root&&!root.disposed&&graphSequence===version&&state.view==='explore';
    async function children(node,sequence,root,version){
      if(node.child)return node.child;
      if(!node.query)return null;
      const data=await graphRequest(node.query);
      if(!current(sequence,root,version))return null;
      installChildren([node],[{data}]);return node.child;
    }
    function reveal(node){
      for(let scene=node.scene;scene?.parent;scene=scene.parent.scene){
        if(!patch.reveals.has(scene))patch.reveals.set(scene,scene.revealAt);
        scene.revealAt=.001;
      }
    }
    function decorate(node,topic,direct){
      if(!patch.nodes.has(node))patch.nodes.set(node,{title:node.title,label:node.label,subtitle:node.subtitle,catalogueFocusRole:node.catalogueFocusRole,color:node.color,labelWidth:node.labelWidth});
      node.color=direct?'#F6C76B':'#8BA9D4';
      node.subtitle=direct?'질문과 연결된 개념':'관련 개념';
      node.catalogueFocusRole=node.subtitle;
      node.labelWidth=Math.max(node.labelWidth||0,170);node.sprite=null;reveal(node);
    }
    function connect(a,b,properties){
      if(!a||!b||a===b)return;
      const edge={a,b,...properties};patch.root.edges.push(edge);a.neighbors.add(b);b.neighbors.add(a);patch.edges.push(edge);
    }
    function addDatasets(result,topics,bandTopics,candidates,direct){
      const byTopic=new Map(),seen=new Set(),additionalTopics=new Set();
      for(const group of (result.groups||[]).slice(0,5))for(const site of (group.sites||[]).slice(0,10)){
        if(!state.sources.some(source=>source.id===site.source_id))continue;
        for(const fact of (site.evidence||[]).slice(0,10)){
          if(seen.size>=10||!fact.dataset_id||seen.has(fact.dataset_id)||!score(fact.cosine))continue;
          let url;try{url=new URL(fact.evidence_url);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)continue;}catch{continue;}
          const matches=(fact.topic_matches||[]).filter(match=>topics.has(match.id)&&score(match.dataset_topic_cosine));
          if(!matches.length)continue;
          const band=['high','low','unclassified'].includes(fact.topic_context?.classification?.level)?fact.topic_context.classification.level:'unclassified';
          const targets=matches.map(match=>bandTopics.get(band+'|'+match.id)||topics.get(match.id));
          const parent=patch.root.data?.view==='topics_v1'&&band!=='unclassified'?topics.get(matches[0].id):
            bandTopics.get(band+'|'+matches[0].id)||patch.root.nodes.find(node=>node.kind==='band'&&node.query?.band===band);
          if(!parent)continue;seen.add(fact.dataset_id);
          for(const node of targets){if(!patch.nodes.has(node)){const topic=candidates.find(topic=>topic.id===node.query?.concept);if(topic)decorate(node,topic,direct.has(topic.id));additionalTopics.add(node);}}
          const record={id:fact.dataset_id,title:fact.title,source_id:site.source_id,publisher:site.name,description:fact.summary||'',url:url.href,metadata_url:url.href,
            confidence_band:band,format:(fact.formats||[]).join(' · '),mappings:matches.map(match=>({concept_id:match.id,status:'approved',confidence:match.dataset_topic_cosine,
              evidence:match.origin==='related'?'관련 개념':'질문과 연결된 개념'}))};
          if(!byTopic.has(parent))byTopic.set(parent,[]);
          byTopic.get(parent).push({id:fact.dataset_id,kind:'dataset',title:fact.title,count:1,record,confidenceBand:band,queryCosine:fact.cosine,matches});
        }
      }
      for(const [parent,nodes] of byTopic){
        const original=parent.child,cached=sceneTree(original).filter(scene=>sceneCache.has(scene));
        if(original){hideScene(original);for(const scene of cached)sceneCache.delete(scene);for(const child of original.nodes){parent.neighbors.delete(child);child.neighbors.delete(parent);}}
        parent.child=null;
        installChildren([parent],[{data:{query:parent.query,nodes,edges:[],represented:nodes.length,total:nodes.length}}]);
        const replacement=parent.child;if(!replacement){parent.child=original;continue;}
        patch.children.push({node:parent,original,replacement,cached});replacement.revealAt=.001;
        for(const node of replacement.nodes){
          node.subtitle=node.record.publisher;node.labelWidth=Math.max(node.labelWidth||0,190);node.sprite=null;
          patch.datasetIDs.add(node.id);
          for(const match of node.matches)connect(node,bandTopics.get(node.confidenceBand+'|'+match.id)||topics.get(match.id),{relation:'accepted_dataset_topic',cosine:match.dataset_topic_cosine});
        }
      }
      return {datasets:[...byTopic.keys()].flatMap(node=>node.child?.nodes||[]),additionalTopics:[...additionalTopics]};
    }
    function moveTo(nodes,sequence,root,version){
      if(!nodes.length)return;if(simulation)stopSprings();
      const rect=canvas.getBoundingClientRect(),dock=document.getElementById('catalogue-chat-panel')?.getBoundingClientRect();
      if(!rect.width||!rect.height)return;
      const sidebar=document.querySelector('.sidebar')?.getBoundingClientRect(),filters=document.querySelector('.filters')?.getBoundingClientRect();
      const left=rect.left+(rect.width>700?Math.max(24,(sidebar?.right||rect.left)-rect.left+36):24),right=rect.right-30;
      const statusBottom=status.getBoundingClientRect().bottom||rect.top+145;
      const top=Math.max(rect.top+100,(filters?.bottom||rect.top)+55,statusBottom+20);
      const zoom=document.querySelector('.zoom')?.getBoundingClientRect();
      const zoomLimit=zoom?.width>0&&zoom.height>0&&zoom.left<right&&zoom.right>left&&zoom.bottom>top?zoom.top-52:Infinity;
      const bottom=Math.max(top+45,Math.min(rect.bottom-80,(dock?.top||rect.bottom)-65,zoomLimit));
      const topics=nodes.filter(node=>node.kind!=='dataset'),datasets=nodes.filter(node=>node.kind==='dataset');
      const width=rect.width>700?560:360,height=width*rect.height/rect.width,unit=width/rect.width;
      const columns=Math.max(1,Math.floor((right-left)/170)),topicRows=Math.ceil(topics.length/columns),datasetRows=Math.ceil(datasets.length/columns);
      const rows=topicRows+datasetRows,rowSpace=rows>1?(bottom-top)/(rows-1):0,places=[];
      function place(items,startRow){
        for(let offset=0;offset<items.length;offset+=columns){
          const row=items.slice(offset,offset+columns),rowIndex=startRow+Math.floor(offset/columns),cell=(right-left)/row.length;
          row.forEach((node,index)=>places.push({node,x:left+cell*(index+.5),y:top+rowSpace*rowIndex,labelWidth:Math.max(80,Math.min(node.labelWidth||170,cell-14))}));
        }
      }
      place(topics,0);place(datasets,topicRows);
      const anchor=places[0],destination=[anchor.node.x-(anchor.x-rect.left)*unit,anchor.node.y-(anchor.y-rect.top)*unit,width,height];
      for(const item of places){
        const node=item.node;
        patch.positions.set(node,{x:node.x,y:node.y,vx:node.vx||0,vy:node.vy||0});
        node.x=destination[0]+(item.x-rect.left)*unit;node.y=destination[1]+(item.y-rect.top)*unit;node.vx=node.vy=0;
        node.labelWidth=item.labelWidth;node.sprite=null;
      }
      patch.focusNodes=new Set(nodes);patch.focusEntities=new Set(nodes.map(node=>node.entity).filter(Boolean));
      const start=[...camera.box],started=performance.now();camera.focus={x:anchor.node.x,y:anchor.node.y};
      function step(now){
        if(!current(sequence,root,version))return;
        const progress=reducedGraphMotion?1:Math.min(1,(now-started)/650),ease=1-(1-progress)**3;
        camera.box=start.map((value,index)=>value+(destination[index]-value)*ease);movingUntil=progress<1?now+80:0;applyBox();
        if(progress<1)frame=requestAnimationFrame(step);else frame=0;
      }
      frame=requestAnimationFrame(step);
    }
    async function showResult(result){
      cancel();const sequence=generation,exploration=result?.exploration;
      if(!['results','partial','unverified'].includes(result?.state)||state.view!=='explore'||exploration?.status!=='ready')return;
      const requested=(exploration.query_topics||[]).slice(0,5).filter(topic=>topicID(topic?.id)&&score(topic.query_cosine));
      if(!requested.length)return;
      try{
        if(Object.values(graphData?.query||{}).some(Boolean)){
          options.onClearFilters();
          const loading=loadGraph({}),version=graphSequence;await loading;
          if(sequence!==generation||graphSequence!==version)return;
        }
        renderGraph();const root=rootScene,version=graphSequence;if(!root||!current(sequence,root,version))return;
        const defined=new Set(state.concepts.map(topic=>topic.id)),direct=new Set(requested.map(topic=>topic.id));
        const candidates=[...requested,...(exploration.related_topics||[]).slice(0,10).filter(topic=>topicID(topic?.id)&&direct.has(topic.via_topic_id)&&score(topic.topic_cosine))].filter(topic=>defined.has(topic.id));
        if(!candidates.length)return;
        const found=new Map(),bandTopics=new Map(),preferred=new Map();
        for(const group of (result.groups||[]).slice(0,5))for(const site of (group.sites||[]).slice(0,10))for(const fact of (site.evidence||[]).slice(0,10)){
          const band=fact.topic_context?.classification?.level;
          if(['high','low'].includes(band))for(const match of (fact.topic_matches||[]).slice(0,15))if(!preferred.has(match.id))preferred.set(match.id,band);
        }
        if(root.data?.view==='topics_v1'){
          for(const topic of candidates){
            const main=root.nodes.find(node=>node.query?.concept===(topic.parent_id||topic.id));if(!main)continue;
            if(main.query.concept===topic.id){found.set(topic.id,main);continue;}
            const subtopics=await children(main,sequence,root,version);if(!current(sequence,root,version))return;
            const node=subtopics?.nodes.find(node=>node.query?.concept===topic.id);if(node)found.set(topic.id,node);
          }
        }
        for(const band of root.nodes.filter(node=>node.kind==='band'&&['high','low'].includes(node.query?.band))){
          const mains=await children(band,sequence,root,version);if(!current(sequence,root,version))return;
          for(const topic of candidates){
            const main=mains?.nodes.find(node=>node.query?.concept===topic.parent_id);if(!main)continue;
            const subtopics=await children(main,sequence,root,version);if(!current(sequence,root,version))return;
            const node=subtopics?.nodes.find(node=>node.query?.concept===topic.id);if(node){bandTopics.set(band.query.band+'|'+topic.id,node);if(!found.has(topic.id)||preferred.get(topic.id)===band.query.band)found.set(topic.id,node);}
          }
        }
        if(!found.size||!current(sequence,root,version))return;
        focusedNode=null;pinnedNode=null;
        if(typeof hoveredNode!=='undefined')hoveredNode=null;
        patch={root,edges:[],children:[],reveals:new Map(),nodes:new Map(),positions:new Map(),scoreAlphas:new Map(),focusNodes:new Set(),focusEntities:new Set(),datasetIDs:new Set()};
        for(const topic of candidates){const node=found.get(topic.id);if(node)decorate(node,topic,direct.has(topic.id));}
        for(const relation of (exploration.relations||[]).slice(0,30))if(relation.relation==='semantic_similarity'&&relation.basis==='stored_topic_vector_cosine'&&score(relation.cosine))
          connect(found.get(relation.source),found.get(relation.target),{relation:relation.relation,basis:relation.basis,cosine:relation.cosine});
        const {datasets,additionalTopics}=addDatasets(result,found,bandTopics,candidates,direct);
        bind(label,'{names} · 이번 검색에서 강조한 주제 {topics}개 · 자료 {datasets}개',()=>({
          names:requested.filter(topic=>found.has(topic.id)).map(topic=>i18n?.topic(topic.id,state.concepts.find(item=>item.id===topic.id)?.name||topic.label)||topic.label).join(' · '),
          topics:i18n?.number(new Set([...found.values(),...additionalTopics]).size)||new Set([...found.values(),...additionalTopics]).size,
          datasets:i18n?.number(datasets.length)||datasets.length
        }));
        status.hidden=false;labelsDirty=true;scheduleGraphFrame();moveTo([...found.values(),...additionalTopics,...datasets],sequence,root,version);
      }catch(error){
        if(sequence===generation){restore();bind(label,'연결된 저장 개념을 표시하지 못했어요. 기존 카탈로그를 탐색할 수 있어요.');status.hidden=false;}
      }
    }
    return {showResult,beginRequest:cancel,reset};
  }
  return {mount};
})();

 const focus=CatalogueGraphFocus.mount({host:options.focusHost});
 const resize=new ResizeObserver(()=>{sizeScene();if(centeredGraphNode)centerGraphNode(centeredGraphNode,false);else fitTopicOverview();scheduleGraphFrame();});resize.observe(canvas);
 listen(window,'resize',()=>{if(!graphView())scheduleGraphFrame();});
 listen(window,'dataieum:node-panel',()=>{if(centeredGraphNode)centerGraphNode(centeredGraphNode);});
 return {
   bootstrap(value){graphData=value.graph;overviewGraphs.set('',value.graph);for(const child of value.graph_children||[])overviewGraphs.set(graphKey(child.query||{}),child);graphCache.set('',Promise.resolve(value.graph));sizeScene();renderGraph();fitTopicOverview();},
   filtersChanged(){focus.beginRequest();for(const request of requests)request.abort();resetMap(false);graphCache.clear();loadGraph(graphQuery());},
   chooseTopic, zoom, reset:()=>{focus.reset();options.onClearFilters();loadGraph({});},
   refresh(){sizeScene();if(graphView()&&!graphLoading&&graphData&&graphKey(graphQuery())!==graphKey(graphData.query||{}))loadGraph(graphQuery());else scheduleGraphFrame();},
   showResult(result){overviewFitted=false;return focus.showResult(result);},beginRequest:focus.beginRequest,
   // The chat dock finished resizing: re-fit only a camera the person has not moved.
   dockChanged(){if(overviewFitted&&!centeredGraphNode)fitTopicOverview(true);},
   localeChanged(){const seen=new Set();function refresh(scene){if(!scene||seen.has(scene))return;seen.add(scene);for(const node of scene.nodes){node.sprite=null;refreshNodeLabel(node);if(node.button)node.button.textContent=nodeAccessibleTitle(node);refresh(node.child);}}refresh(rootScene);for(const scene of sceneCache.keys())refresh(scene);labelsDirty=true;scheduleGraphFrame();},
   destroy(){disposed=true;graphSequence++;lifetime.abort();resize.disconnect();for(const request of requests)request.abort();for(const id of timers)window.clearTimeout(id);for(const id of frames)window.cancelAnimationFrame(id);if(rootScene)releaseScene(rootScene);cosmosBackdrop.remove();starCanvas.remove();options.focusHost.replaceChildren();}
 };
}
