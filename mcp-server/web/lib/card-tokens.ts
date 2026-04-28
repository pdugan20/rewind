// Centralized outer-card chrome — bg + border — so every top-level
// MCP UI surface (AlbumGrid, PosterGrid, ArticleList, ArticleDetail,
// ArtistDetail, AthleteDetailA, GameCard, TopTracks, ArtistGrid) renders
// the same container in light + dark mode.
//
// Theme switching is driven by `prefers-color-scheme: dark`, which
// matches both macOS system theme and the `color-scheme` declaration
// the workbench (and Claude) sets on `:root`.
//
// Two injection paths share this CSS string:
//   1. Module-level side effect below — covers production, where
//      components mount inside their own iframe and `document` is
//      already the iframe's document.
//   2. `web-workbench/src/IframeShell.tsx` imports `CARD_TOKENS_CSS`
//      and injects it into the workbench iframe's document, because
//      the workbench portals React children into an iframe and the
//      module's parent-side side effect would target the wrong doc.

import { type CSSProperties } from 'react';

export const CARD_TOKENS_STYLE_ID = 'rewind-card-tokens';

export const CARD_TOKENS_CSS = `
:root {
  --card-bg: #fcfcfa;
  --card-border: #d9d9d9;
}
@media (prefers-color-scheme: dark) {
  :root {
    --card-bg: #272726;
    --card-border: #383836;
  }
}
`;

if (
  typeof document !== 'undefined' &&
  !document.getElementById(CARD_TOKENS_STYLE_ID)
) {
  const style = document.createElement('style');
  style.id = CARD_TOKENS_STYLE_ID;
  style.textContent = CARD_TOKENS_CSS;
  document.head.appendChild(style);
}

// Spread into the cardStyle of any top-level container component.
export const cardOuterChrome: CSSProperties = {
  background: 'var(--card-bg)',
  border: '1px solid var(--card-border)',
};
