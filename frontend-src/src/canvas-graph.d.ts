import type {Bootstrap, Dataset, Filters, GraphNode, I18n, Source, Topic} from './types';
export interface GraphState {sources: Source[]; concepts: Topic[]; filters: Filters; view: 'explore'|'sources'; mode: 'graph'|'list'; selectedRecord: Dataset|null}
export interface GraphController {
  bootstrap(value: Bootstrap): void; filtersChanged(): void; chooseTopic(id: string, sidebar?: boolean): void;
  zoom(factor: number): void; reset(): void; refresh(): void; localeChanged(): void;
  showResult(result: unknown): Promise<void>; beginRequest(): void; dockChanged(): void; destroy(): void;
}
export function mountGraph(options: {
  canvas: HTMLCanvasElement; focusHost: HTMLElement; i18n: I18n; getState: ()=>GraphState;
  onSelect: (record: Dataset|null)=>void; onNode: (node:GraphNode)=>void; onTopic: (id:string)=>void;
  onReset: ()=>void; onClearFilters: ()=>void; onNotice: (message:string,error?:boolean)=>void;
  onLoading: (loading:boolean)=>void; onCaption: (caption:string)=>void;
}): GraphController;
