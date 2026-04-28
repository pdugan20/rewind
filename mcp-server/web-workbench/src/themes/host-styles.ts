/**
 * Approximations of the CSS variables Claude Desktop / iOS injects into
 * MCP UI iframes via `useHostStyles(app)`. Anthropic doesn't publish exact
 * values, so these are eyeballed from observed renders and refined as we
 * iterate. The host can change these any time — treat as best-effort.
 */
export type Theme = 'light' | 'dark';

const lightVars: Record<string, string> = {
  '--font-sans':
    '-apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", "Helvetica Neue", system-ui, sans-serif',
  '--color-text-primary': '#1a1a1a',
  '--color-text-secondary': 'rgba(0,0,0,0.62)',
  // Elevated surface (active pill toggles, etc). In light mode the
  // card sits at #fcfcfc and the elevated surface is pure white so
  // selected state pops above it.
  '--color-background-primary': '#ffffff',
  '--color-background-secondary': 'rgba(0,0,0,0.04)',
  '--color-border-tertiary': 'rgba(0,0,0,0.10)',
  // Card chrome — drives the workbench Light/Dark toggle directly.
  // Production hosts use the prefers-color-scheme defaults from
  // card-tokens.ts; here we override per the explicit toggle since
  // prefers-color-scheme tracks the OS, not the workbench's switch.
  // Card sits a hair darker than the page (#fcfcfc) so it reads as
  // a distinct surface even before the border kicks in. Anthropic's
  // "Ivory Light" — warm-tinted off-white that fits Claude's brand
  // rather than the slightly bluish neutral grays.
  '--card-bg': '#fcfcfa',
  '--card-border': '#d9d9d9',
  // Bug-bait: GameCard.tsx references --color-bg-secondary instead of
  // --color-background-secondary. We deliberately don't define the typo'd
  // name so the workbench surfaces the inconsistency.
};

const darkVars: Record<string, string> = {
  '--font-sans':
    '-apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", "Helvetica Neue", system-ui, sans-serif',
  '--color-text-primary': '#f5f5f7',
  '--color-text-secondary': 'rgba(255,255,255,0.65)',
  // In dark mode the card is #272726; the elevated surface is a
  // visible step lighter so an active pill toggle reads as raised
  // rather than sunken.
  '--color-background-primary': '#3a3938',
  '--color-background-secondary': 'rgba(255,255,255,0.06)',
  '--color-border-tertiary': 'rgba(255,255,255,0.12)',
  '--card-bg': '#272726',
  '--card-border': '#383836',
};

// Workbench page background — matched to Claude Desktop's light surface
// so the card chrome reads against the same backdrop as production.
const lightPage = {
  background: '#fcfcfc',
  color: '#1a1a1a',
};

const darkPage = {
  background: '#1d1d1c',
  color: '#f5f5f7',
};

export function themeStyleSheet(theme: Theme): string {
  const vars = theme === 'dark' ? darkVars : lightVars;
  const page = theme === 'dark' ? darkPage : lightPage;
  const decls = Object.entries(vars)
    .map(([k, v]) => `  ${k}: ${v};`)
    .join('\n');
  return `
:root {
  color-scheme: ${theme};
${decls}
}
html, body {
  margin: 0;
  background: ${page.background};
  color: ${page.color};
  font-family: var(--font-sans);
  -webkit-font-smoothing: antialiased;
  /* Hide scrollbars in the workbench iframe — the rest of the conversation
     scrolls in real Claude, so the embedded component never shows its own.   */
  scrollbar-width: none;
  -ms-overflow-style: none;
}
html::-webkit-scrollbar,
body::-webkit-scrollbar {
  display: none;
  width: 0;
  height: 0;
}
`;
}
