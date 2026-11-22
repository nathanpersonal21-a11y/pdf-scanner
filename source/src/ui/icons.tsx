import type { ReactNode } from 'react';

const I = ({ children, size = 24 }: { children: ReactNode; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
);

export const Camera = (p: { size?: number }) => (
  <I {...p}><path d="M4 8h3l1.6-2.4h6.8L17 8h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z" /><circle cx="12" cy="13" r="3.6" /></I>
);
export const ImageIcon = (p: { size?: number }) => (
  <I {...p}><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="8.5" cy="9.5" r="1.5" /><path d="M21 16l-5-5-8 8" /></I>
);
export const Crop = (p: { size?: number }) => (
  <I {...p}><path d="M6 2v14a2 2 0 0 0 2 2h14" /><path d="M2 6h14a2 2 0 0 1 2 2v14" /></I>
);
export const Rotate = (p: { size?: number }) => (
  <I {...p}><path d="M20 12a8 8 0 1 1-2.6-5.9" /><path d="M20 4v5h-5" /></I>
);
export const Trash = (p: { size?: number }) => (
  <I {...p}><path d="M4 7h16" /><path d="M9 7V4h6v3" /><path d="M6 7l1 13h10l1-13" /><path d="M10 11v5M14 11v5" /></I>
);
export const Plus = (p: { size?: number }) => (
  <I {...p}><path d="M12 5v14M5 12h14" /></I>
);
export const Replace = (p: { size?: number }) => (
  <I {...p}><path d="M4 8h13l-3-3" /><path d="M20 16H7l3 3" /></I>
);
export const Back = (p: { size?: number }) => (
  <I {...p}><path d="M15 5l-7 7 7 7" /></I>
);
export const Close = (p: { size?: number }) => (
  <I {...p}><path d="M6 6l12 12M18 6L6 18" /></I>
);
export const Check = (p: { size?: number }) => (
  <I {...p}><path d="M5 12.5l4.5 4.5L19 7.5" /></I>
);
export const Download = (p: { size?: number }) => (
  <I {...p}><path d="M12 4v11" /><path d="M7.5 11l4.5 4.5 4.5-4.5" /><path d="M5 20h14" /></I>
);
export const Share = (p: { size?: number }) => (
  <I {...p}><path d="M12 15V4" /><path d="M8 7.5L12 3.5l4 4" /><path d="M6 11H5a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7a1 1 0 0 0-1-1h-1" /></I>
);
export const Flip = (p: { size?: number }) => (
  <I {...p}><path d="M4 9V6a2 2 0 0 1 2-2h12" /><path d="M15 1l3 3-3 3" /><path d="M20 15v3a2 2 0 0 1-2 2H6" /><path d="M9 23l-3-3 3-3" /></I>
);
export const Compare = (p: { size?: number }) => (
  <I {...p}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M12 4v16" /><path d="M7 10h2M7 14h2" /></I>
);
export const Wand = (p: { size?: number }) => (
  <I {...p}><path d="M5 19L16 8" /><path d="M14 6l4 4" /><path d="M18 3v2M17 4h2M6 5v2M5 6h2M20 13v2M19 14h2" /></I>
);
export const Expand = (p: { size?: number }) => (
  <I {...p}><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" /></I>
);
export const File = (p: { size?: number }) => (
  <I {...p}><path d="M6 3h8l4 4v14H6z" /><path d="M14 3v4h4" /></I>
);
