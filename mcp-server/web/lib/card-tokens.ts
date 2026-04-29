// Centralized outer-card chrome — bg + border + radius + overflow — so
// every top-level MCP UI surface (AlbumGrid, PosterGrid, ArticleList,
// ArticleDetail, ArtistDetail, AthleteDetail/A, GameCard, TopTracks,
// ArtistGrid) renders the same container in light + dark mode and
// across hosts.
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
//
// Card-radius single point of control:
//   - The `.rewind-card-outer` class binds `border-radius` to
//     `var(--rewind-card-radius)`, default 12px.
//   - The iOS-only override below detects `/iPad|iPhone|iPod/` in the
//     userAgent and rewrites the var to 0. Claude iOS wraps the
//     iframe in its own rounded container; if we ALSO round the
//     content the two masks fight at the corner and our 1px border
//     gets washed out. Setting our radius to 0 lets Claude's outer
//     mask be the only thing rounding the visible card.
//   - Workbench and Claude Desktop never match the iOS UA, so they
//     keep the 12px default — which is correct since neither has an
//     outer rounded host wrapper to defer to.
//
// Future card-shape tweaks (radius, overflow, future host overrides)
// live in this file; components only carry the className.

import { type CSSProperties } from 'react';

export const CARD_TOKENS_STYLE_ID = 'rewind-card-tokens';
export const CARD_TOKENS_IOS_OVERRIDE_STYLE_ID = 'rewind-card-tokens-ios';

/** className applied to every top-level card root element. */
export const CARD_OUTER_CLASSNAME = 'rewind-card-outer';

export const CARD_TOKENS_CSS = `
html, body {
  margin: 0;
  padding: 0;
  /* Match Claude's loading-surface colors so the brief paint window
     before our card mounts blends with the host shimmer. Transparent
     used to fall through to browser-default white on iOS for a frame
     before our content rendered. Workbench overrides this via
     host-styles.ts with a page bg keyed to its manual theme toggle. */
  background: #F3F0EF;
}
@media (prefers-color-scheme: dark) {
  html, body {
    background: #121212;
  }
}
:root {
  /* Opt the iframe into both schemes so light-dark() below resolves
     against the user agent / host's preferred scheme. Workbench's
     themeStyleSheet overrides this with the explicit toggle value;
     iOS WebKit picks up the system theme. */
  color-scheme: light dark;
  --card-bg: #fcfcfa;
  --card-border: #d9d9d9;
  --rewind-card-radius: 12px;
}
@media (prefers-color-scheme: dark) {
  :root {
    --card-bg: #272726;
    --card-border: #383836;
  }
}
.${CARD_OUTER_CLASSNAME} {
  border-radius: var(--rewind-card-radius);
  overflow: hidden;
  /* Scoped text + surface tokens. We define these on the card root
     so they contrast with our --card-bg regardless of what the host
     injects at :root. Claude iOS injects values keyed to Claude's
     bg, not ours, which produced the muted / barely-legible dark-
     mode rendering on 0.8.11. Using light-dark() (rather than a
     media query) keys these to the resolved color-scheme — same
     mechanism the workbench's manual toggle drives via
     host-styles.ts — so the workbench preview and production
     iOS render identically without a split between
     prefers-color-scheme and the workbench's own theme state. */
  --color-text-primary: light-dark(#1a1a1a, #f5f5f7);
  --color-text-secondary: light-dark(rgba(0, 0, 0, 0.62), rgba(255, 255, 255, 0.65));
  --color-border-tertiary: light-dark(rgba(0, 0, 0, 0.10), rgba(255, 255, 255, 0.12));
  --color-background-primary: light-dark(#ffffff, #3a3938);
  --color-background-secondary: light-dark(rgba(0, 0, 0, 0.04), rgba(255, 255, 255, 0.06));
}
/* Kill iOS WebKit's default gray rectangular tap-highlight on every
   interactive element across the iframe — it ignores border-radius
   and looks ugly on cards with rounded chrome. Replace it with a
   subtle :active background tint on real buttons / role=button
   elements so the user still gets touch feedback. Plain
   <div onClick> rows fall through this generic rule and need an
   :active style of their own. */
* {
  -webkit-tap-highlight-color: transparent;
}
button:active,
[role='button']:active,
a:active {
  background-color: rgba(127, 127, 127, 0.08);
}
`;

// iOS override: zero out BOTH our radius and our border. Claude iOS
// wraps the iframe in its own rounded container with its own visible
// edge — anything we draw inside competes with that. With radius:0 +
// transparent border, our card becomes pure content (bg + children)
// inside Claude's mask, and Claude's host edge is the only thing
// rendering at the corners. Workbench and Claude Desktop don't get
// this override (their UA / standalone signals don't match), so they
// keep the 12px radius + 1px border they need to define their card.
const IOS_RADIUS_OVERRIDE_CSS = `:root {
  --rewind-card-radius: 0px;
  --card-border: transparent;
}`;

if (typeof document !== 'undefined') {
  if (!document.getElementById(CARD_TOKENS_STYLE_ID)) {
    const style = document.createElement('style');
    style.id = CARD_TOKENS_STYLE_ID;
    style.textContent = CARD_TOKENS_CSS;
    document.head.appendChild(style);
  }

  // iOS-only override: see the radius-control comment at the top of
  // the file for the rationale. We use multiple signals because
  // Claude iOS's WKWebView may use a custom UA string that doesn't
  // include "iPhone/iPad/iPod":
  //   - `'standalone' in navigator` is the most reliable — that
  //     property exists only on iOS Safari and WKWebView. Survives
  //     UA spoofing.
  //   - UA regex catches stock iOS / mobile-web fallbacks.
  //   - The iPad-on-macOS trick (Macintosh UA + touch points) catches
  //     iPads that report as desktop Mac.
  // Claude Desktop's Electron Chromium fails all three.
  if (
    typeof navigator !== 'undefined' &&
    !document.getElementById(CARD_TOKENS_IOS_OVERRIDE_STYLE_ID)
  ) {
    const ua = navigator.userAgent;
    const isIOS =
      'standalone' in navigator ||
      /iPad|iPhone|iPod/.test(ua) ||
      (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
    if (isIOS) {
      const override = document.createElement('style');
      override.id = CARD_TOKENS_IOS_OVERRIDE_STYLE_ID;
      override.textContent = IOS_RADIUS_OVERRIDE_CSS;
      document.head.appendChild(override);
    }
  }
}

// Spread into the cardStyle of any top-level container component.
// (Radius + overflow are applied via the `.rewind-card-outer`
// className — see CARD_OUTER_CLASSNAME — so they can vary per host.)
export const cardOuterChrome: CSSProperties = {
  background: 'var(--card-bg)',
  border: '1px solid var(--card-border)',
};
