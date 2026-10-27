import {useSyncExternalStore} from 'react';
import {i18n} from './i18n-core';
export {i18n};
export const t=(text:string,params:Record<string,unknown>={})=>i18n.text(text,params);
export function useLocale(){return useSyncExternalStore(i18n.subscribe,i18n.getLocale,i18n.getLocale);}
