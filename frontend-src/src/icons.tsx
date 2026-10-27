const paths={
  map:<><circle cx="6" cy="7" r="2.2"/><circle cx="18" cy="6" r="2.2"/><circle cx="12" cy="17.5" r="2.2"/><path d="M8 7.6l7.9-1.1M7.2 8.9l3.6 6.7M16.9 8l-3.8 7.6"/></>,
  sites:<><rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M3.5 9h17M8 4.5V9"/></>,
  list:<><path d="M9.5 7h10M9.5 12h10M9.5 17h10"/><circle cx="5" cy="7" r="1.1" fill="currentColor"/><circle cx="5" cy="12" r="1.1" fill="currentColor"/><circle cx="5" cy="17" r="1.1" fill="currentColor"/></>,
  search:<><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/></>,
  filter:<path d="M4 6h16M7 12h10M10 18h4"/>,
  bookmark:<path d="M7 4.5h10a1 1 0 0 1 1 1V20l-6-3.8L6 20V5.5a1 1 0 0 1 1-1z"/>,
  help:<><circle cx="12" cy="12" r="8.5"/><path d="M9.7 9.6a2.4 2.4 0 1 1 3.3 2.2c-.6.3-1 .8-1 1.5v.6"/><circle cx="12" cy="16.9" r=".6" fill="currentColor"/></>,
  close:<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>,
  plus:<path d="M12 5.5v13M5.5 12h13"/>,
  minus:<path d="M5.5 12h13"/>,
  reset:<><path d="M5 12a7 7 0 1 0 2.1-5"/><path d="M5 4.5V8h3.5"/></>,
  external:<><path d="M13.5 5.5h5v5M18.5 5.5l-8 8"/><path d="M17 13.5v4a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 5 17.5v-9A1.5 1.5 0 0 1 6.5 7h4"/></>,
  compare:<><rect x="3.5" y="4.5" width="7" height="15" rx="1.5"/><rect x="13.5" y="4.5" width="7" height="15" rx="1.5"/><path d="M5.8 8.5h2.4M5.8 11.5h2.4M15.8 8.5h2.4M15.8 11.5h2.4"/></>,
  check:<path d="M5.5 12.5l4 4 9-9"/>,
  chevron:<path d="M9.5 6.5l5.5 5.5-5.5 5.5"/>,
  spark:<path d="M12 3.5l1.9 5.1 5.1 1.9-5.1 1.9L12 17.5l-1.9-5.1L5 10.5l5.1-1.9zM18.5 15.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/>,
  expand:<path d="M14 5h5v5M10 19H5v-5M19 5l-5.5 5.5M5 19l5.5-5.5"/>,
  shrink:<path d="M19 10h-5V5M5 14h5v5M14 10l5.5-5.5M10 14l-5.5 5.5"/>,
  trash:<path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/>,
};
export type IconName=keyof typeof paths;
export function Icon({name,size=18}:{name:IconName;size?:number}) {
  return <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{paths[name]}</svg>;
}
