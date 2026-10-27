export class ApiError extends Error {
  constructor(message: string, public status: number, public code: string) {super(message);}
}
type ReadJob = {path: string; options: RequestInit; priority: number; resolve: (v:unknown)=>void; reject: (e:unknown)=>void; abort: ()=>void; settled: boolean};
const waiting: ReadJob[] = [];
let active = false;
const abortError = (signal: AbortSignal) => signal.reason ?? new DOMException('Aborted', 'AbortError');
function delay(ms: number, signal?: AbortSignal | null) {
  return new Promise<void>((resolve, reject) => {
    if(signal?.aborted) {reject(abortError(signal));return;}
    const timer=setTimeout(()=>{signal?.removeEventListener('abort',abort);resolve();},ms);
    const abort=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);reject(abortError(signal!));};
    signal?.addEventListener('abort',abort,{once:true});
  });
}
async function request(path: string, options: RequestInit): Promise<unknown> {
  const response=await fetch(path,{...options,cache:'no-store'});
  let value: unknown;
  try {value=await response.json();} catch {throw new ApiError('서버 응답을 읽지 못했어요.',response.status,'invalid_json');}
  if(!response.ok) {
    const code=value && typeof value==='object' && 'code' in value ? String(value.code) : 'http_error';
    throw new ApiError(response.status===409 ? '자료가 갱신됐어요. 검색을 다시 실행해 주세요.' : '요청을 처리하지 못했어요. 잠시 후 다시 시도해 주세요.',response.status,code);
  }
  return value;
}
function settle(job: ReadJob, error: unknown, value?: unknown) {
  if(job.settled)return;
  job.settled=true;job.options.signal?.removeEventListener('abort',job.abort);
  if(error)job.reject(error);else job.resolve(value);
}
function pump() {
  if(active||!waiting.length)return;
  waiting.sort((a,b)=>a.priority-b.priority);
  const job=waiting.shift()!;active=true;
  void (async()=>{
    try {
      for(let attempt=0;attempt<4;attempt++) {
        if(job.options.signal?.aborted)throw abortError(job.options.signal);
        try {const value=await request(job.path,job.options);settle(job,null,value);return;}
        catch(error) {
          if(job.options.signal?.aborted)throw abortError(job.options.signal);
          if(!(error instanceof ApiError)||error.status!==503||attempt===3)throw error;
          await delay(1000*2**attempt,job.options.signal);
        }
      }
    } catch(error) {settle(job,error);}
    finally {active=false;pump();}
  })();
}
export function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  if(options.method && options.method!=='GET')return request(path,options) as Promise<T>;
  if(!/^\/api\/(bootstrap|graph|catalog|compare|datasets)(?:[/?]|$)/.test(path))return request(path,options) as Promise<T>;
  if(options.signal?.aborted)return Promise.reject(abortError(options.signal));
  if(waiting.length>=16)return Promise.reject(new ApiError('자료 조회 요청이 많아요. 잠시 후 다시 시도해 주세요.',503,'queue_full'));
  return new Promise<T>((resolve,reject)=>{
    const priority=path.startsWith('/api/compare')?0:path.startsWith('/api/catalog/count')?3:path.startsWith('/api/graph')?2:1;
    const job:ReadJob={path,options,priority,resolve:value=>resolve(value as T),reject,settled:false,abort:()=>{
      const index=waiting.indexOf(job);if(index>=0)waiting.splice(index,1);
      settle(job,abortError(options.signal!));pump();
    }};
    options.signal?.addEventListener('abort',job.abort,{once:true});waiting.push(job);pump();
  });
}
export function safeURL(value?: string): string | undefined {
  try {const url=new URL(value||'');if(['http:','https:'].includes(url.protocol)&&!url.username&&!url.password)return url.href;}catch{}
}
