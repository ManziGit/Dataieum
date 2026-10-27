export function graphResult(value){
    if(!value||!['results','partial','unverified','clarify'].includes(value.state)||!value.plan||!Array.isArray(value.plan.needs)||value.plan.needs.length>5)return null;
    const id=value=>typeof value==='string'&&/^[a-z][a-z0-9_]{0,79}$/.test(value)?value:null;
    const stored=value=>typeof value==='string'&&/^M\d{2,4}(?:-S\d{2,4})?$/.test(value)?value:null;
    const datasetID=value=>typeof value==='string'&&value.length>0&&value.length<=512&&!/[\u0000-\u001f\u007f]/.test(value)?value:null;
    const text=(value,max=240)=>typeof value==='string'?value.slice(0,max):'';
    const score=value=>Number.isFinite(value)&&Math.abs(value)<=1;
    const url=value=>{try{if(typeof value!=='string'||value.length>2048)return '';const parsed=new URL(value);return ['http:','https:'].includes(parsed.protocol)&&!parsed.username&&!parsed.password?parsed.href:'';}catch{return '';}};
    const list=(value,max)=>Array.isArray(value)?value.slice(0,max):[];
    const context=value=>['high','low','unclassified'].includes(value?.classification?.level)&&score(value.classification.max_similarity)?{
      version:text(value.version,100),classification:{level:value.classification.level,max_similarity:value.classification.max_similarity},
      topics:list(value.topics,15).filter(topic=>stored(topic?.id)&&score(topic.similarity)&&topic.level===value.classification.level)
        .map(topic=>({id:topic.id,label:text(topic.label,160),similarity:topic.similarity,level:topic.level}))}:null;
    const needs=value.plan.needs.map(need=>({indicator:id(need?.indicator)})).filter(need=>need.indicator);
    const input=value.exploration,exploration={status:['ready','unavailable','no_match'].includes(input?.status)?input.status:'unavailable',
      version:text(String(input?.version||''),80),query_topics:[],related_topics:[],relations:[]};
    const seen=new Set();
    for(const topic of list(input?.query_topics,5)){
      if(!stored(topic?.id)||!stored(topic.parent_id)||!score(topic.query_cosine)||seen.has(topic.id))continue;
      seen.add(topic.id);exploration.query_topics.push({id:topic.id,parent_id:topic.parent_id,label:text(topic.label,160),definition:text(topic.definition,2000),query_cosine:topic.query_cosine});
    }
    const queryIDs=new Set(seen);
    for(const topic of list(input?.related_topics,10)){
      if(!stored(topic?.id)||!stored(topic.parent_id)||!queryIDs.has(topic.via_topic_id)||!score(topic.topic_cosine)||seen.has(topic.id))continue;
      seen.add(topic.id);exploration.related_topics.push({id:topic.id,parent_id:topic.parent_id,label:text(topic.label,160),definition:text(topic.definition,2000),via_topic_id:topic.via_topic_id,topic_cosine:topic.topic_cosine});
    }
    for(const relation of list(input?.relations,30))if(relation?.relation==='semantic_similarity'&&relation.basis==='stored_topic_vector_cosine'&&queryIDs.has(relation.source)&&seen.has(relation.target)&&relation.source!==relation.target&&score(relation.cosine))
      exploration.relations.push({source:relation.source,target:relation.target,relation:relation.relation,basis:relation.basis,cosine:relation.cosine});
    const groups=[],records=new Set(),sites=new Set();let count=0;
    for(const group of list(value.groups,5)){
      if(!id(group?.indicator))continue;
      const clean={indicator:group.indicator,name:text(group.name,160),sites:[]};
      for(const site of list(group.sites,10)){
        if(!datasetID(site?.source_id)||(!sites.has(site.source_id)&&sites.size>=10))continue;
        const evidence=[];
        for(const fact of list(site.evidence,10)){
          if(count>=10||!datasetID(fact?.dataset_id)||records.has(fact.dataset_id)||!score(fact.cosine)||!url(fact.evidence_url))continue;
          const matches=list(fact.topic_matches,15).filter(t=>t&&seen.has(t.id)&&score(t.dataset_topic_cosine)&&
            (t.origin==='query_match'&&queryIDs.has(t.id)||t.origin==='related'&&exploration.related_topics.some(r=>r.id===t.id&&r.via_topic_id===t.via_topic_id)))
            .map(t=>({id:t.id,label:text(t.label,160),definition:text(t.definition,2000),origin:t.origin,...(t.origin==='related'?{via_topic_id:t.via_topic_id}:{}),dataset_topic_cosine:t.dataset_topic_cosine}));
          evidence.push({dataset_id:fact.dataset_id,title:text(fact.title),summary:text(fact.summary,1500),evidence_url:url(fact.evidence_url),cosine:fact.cosine,
            formats:list(fact.formats,8).map(v=>text(v,40)),topic_matches:matches,topic_context:context(fact.topic_context)});records.add(fact.dataset_id);count++;
        }
        if(evidence.length){clean.sites.push({source_id:site.source_id,name:text(site.name,160),url:url(site.url),evidence});sites.add(site.source_id);}
      }
      if(clean.sites.length)groups.push(clean);
    }
    return {state:value.state,plan:{selected_concept:id(value.plan.selected_concept),needs},groups,exploration};
  }
