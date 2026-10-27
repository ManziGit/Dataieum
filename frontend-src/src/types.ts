export type Locale = 'ko' | 'en';
export type Filters = { q: string; source: string; concept: string; year: string; band: string };
export const emptyFilters: Filters = {q: '', source: '', concept: '', year: '', band: ''};
export type Topic = {id: string; name: string; definition?: string; main_id?: string};
export type Source = {id: string; name: string; country?: string; authority?: string; url?: string; docs?: string; stored_count?: number; dataset_count?: number; last_error?: string};
export type Mapping = {concept_id: string; status?: string; evidence?: string; similarity?: number};
export type Dataset = {id: string; source_id: string; title: string; description: string; url?: string; metadata_url?: string; publisher?: string; region?: string; period?: string; reference_year?: number; reference_years?: number[]; year_basis?: string; updated_year?: number; format?: string; license?: string; checked_at?: string; mappings: Mapping[]; classification_note?: {reason?: string}};
export type GraphData = {nodes: GraphNode[]; edges: unknown[]; total: number; represented?: number; query: Partial<Filters>; view?: string};
export type GraphNode = {id: string; kind: string; title: string; count?: number; query?: Partial<Filters>; record?: Dataset; level?: string};
export type Bootstrap = {sources: Source[]; concepts: Topic[]; summary: {datasets?: number; concept_counts: Record<string,number>; year_counts: Record<string,number>}; graph: GraphData; graph_children?: GraphData[]; publication?: string};
export type Page = {datasets: Dataset[]; next_cursor: string | null; has_more: boolean; publication: string};
export interface I18n {
  text(value: string, params?: Record<string,unknown> | (()=>Record<string,unknown>)): string;
  number(value: number): string;
  topic(id: string, original: string, field?: string): string;
  field(kind: string, id: string, field: string, original: string): {text: string; original: string; translated: boolean};
  getLocale(): Locale;
  setLocale(locale: Locale): void;
  subscribe(fn: ()=>void): ()=>void;
}
declare global { interface Window { DataieumI18n: I18n } }
