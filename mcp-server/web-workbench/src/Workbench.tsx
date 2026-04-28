import {
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { COMPONENTS } from './registry';
import { IframeShell } from './IframeShell';
import type { Theme } from './themes/host-styles';

// Claude Desktop caps the conversation + embedded component width at ~720px;
// iPhone Claude renders at device width. Presets reflect what users actually see.
const VIEWPORT_PRESETS: { label: string; width: number }[] = [
  { label: 'iPhone Pro', width: 402 },
  { label: 'Desktop max', width: 720 },
];

type RenderMode = 'hmr' | 'built';

function readInitialState() {
  if (typeof window === 'undefined') return null;
  const p = new URLSearchParams(window.location.search);
  return {
    c: p.get('c'),
    v: p.get('v'),
    w: p.get('w') ? Number(p.get('w')) : null,
    t: p.get('t') as Theme | null,
    m: p.get('m') as RenderMode | null,
  };
}

export function Workbench() {
  const initial = useMemo(readInitialState, []);

  const [selectedId, setSelectedId] = useState<string>(() => {
    const fromUrl = initial?.c;
    return fromUrl && COMPONENTS.some((c) => c.id === fromUrl)
      ? fromUrl
      : COMPONENTS[0].id;
  });
  const [variant, setVariant] = useState<string>(() => initial?.v || 'default');
  const [theme, setTheme] = useState<Theme>(
    initial?.t === 'dark' ? 'dark' : 'light'
  );
  const [width, setWidth] = useState<number>(() => {
    const w = initial?.w;
    return w && w >= 240 && w <= 2400 ? w : 720;
  });
  const [mode, setMode] = useState<RenderMode>(
    initial?.m === 'built' ? 'built' : 'hmr'
  );
  const [builtHtml, setBuiltHtml] = useState<string | null>(null);
  const [builtState, setBuiltState] = useState<'idle' | 'loading' | 'missing'>(
    'idle'
  );

  const selected = useMemo(
    () => COMPONENTS.find((c) => c.id === selectedId)!,
    [selectedId]
  );

  const variants = Object.keys(selected.fixtures);
  const activeVariant = variants.includes(variant) ? variant : variants[0];
  const fixture = selected.fixtures[activeVariant];

  // Reflect current state in the URL so reloads and shared links restore.
  useEffect(() => {
    const p = new URLSearchParams();
    p.set('c', selectedId);
    p.set('v', activeVariant);
    p.set('w', String(width));
    p.set('t', theme);
    p.set('m', mode);
    const next = `${window.location.pathname}?${p.toString()}`;
    if (next !== window.location.pathname + window.location.search) {
      window.history.replaceState(null, '', next);
    }
  }, [selectedId, activeVariant, width, theme, mode]);

  // Lazy-load the built bundle when entering built mode (or switching
  // components while in built mode).
  useEffect(() => {
    if (mode !== 'built') {
      setBuiltHtml(null);
      setBuiltState('idle');
      return;
    }
    let cancelled = false;
    setBuiltState('loading');
    selected
      .getBuiltHtml()
      .then((html) => {
        if (cancelled) return;
        if (html) {
          setBuiltHtml(html);
          setBuiltState('idle');
        } else {
          setBuiltHtml(null);
          setBuiltState('missing');
        }
      })
      .catch(() => {
        if (cancelled) return;
        setBuiltHtml(null);
        setBuiltState('missing');
      });
    return () => {
      cancelled = true;
    };
  }, [mode, selected]);

  return (
    <div style={shellStyle(theme)}>
      <aside style={navStyle}>
        <div style={navHeaderStyle}>Rewind MCP UI</div>
        <ul style={navListStyle}>
          {COMPONENTS.map((c) => (
            <li key={c.id}>
              <button
                onClick={() => {
                  setSelectedId(c.id);
                  setVariant('default');
                }}
                style={{
                  ...navButtonStyle,
                  background:
                    c.id === selectedId ? 'rgba(0,0,0,0.06)' : 'transparent',
                  fontWeight: c.id === selectedId ? 600 : 400,
                }}
              >
                <div>{c.displayName}</div>
                <div style={navSubStyle}>{c.producedBy}</div>
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <main style={mainStyle}>
        <header style={toolbarStyle}>
          <div style={titleBlockStyle}>
            <div style={mainTitleStyle}>{selected.displayName}</div>
            <div style={mainSubStyle}>{selected.producedBy}</div>
          </div>

          <div style={controlsStyle}>
            <Group label="Viewport">
              <div style={rowStyle}>
                <SegGroup>
                  {VIEWPORT_PRESETS.map((p, i) => (
                    <SegBtn
                      key={p.width}
                      active={width === p.width}
                      onClick={() => setWidth(p.width)}
                      title={`${p.label} (${p.width}px)`}
                      isLast={i === VIEWPORT_PRESETS.length - 1}
                    >
                      {p.width}
                    </SegBtn>
                  ))}
                </SegGroup>
                <input
                  type="number"
                  min={240}
                  max={2400}
                  value={width}
                  onChange={(e) =>
                    setWidth(
                      Math.max(240, Math.min(2400, +e.target.value || 0))
                    )
                  }
                  style={inputStyle}
                  aria-label="Custom width in pixels"
                />
              </div>
            </Group>

            <Group label="Theme">
              <SegGroup>
                <SegBtn
                  active={theme === 'light'}
                  onClick={() => setTheme('light')}
                >
                  Light
                </SegBtn>
                <SegBtn
                  active={theme === 'dark'}
                  onClick={() => setTheme('dark')}
                  isLast
                >
                  Dark
                </SegBtn>
              </SegGroup>
            </Group>

            <Group label="Render">
              <SegGroup>
                <SegBtn active={mode === 'hmr'} onClick={() => setMode('hmr')}>
                  HMR
                </SegBtn>
                <SegBtn
                  active={mode === 'built'}
                  onClick={() => setMode('built')}
                  isLast
                >
                  Built
                </SegBtn>
              </SegGroup>
            </Group>

            <Group label="Fixture">
              <select
                value={activeVariant}
                onChange={(e) => setVariant(e.target.value)}
                style={selectStyle}
              >
                {variants.map((v) => (
                  <option key={v} value={v}>
                    {prettyVariant(v)}
                  </option>
                ))}
              </select>
            </Group>
          </div>
        </header>

        <section style={previewStyle(theme)}>
          <div style={previewWrapStyle}>
            <div style={{ ...componentFrameStyle, width }}>
              <ToolHeader producedBy={selected.producedBy} theme={theme} />
              <div style={iframeWrapStyle}>
                {mode === 'hmr' ? (
                  <IframeShell mode="hmr" width={width} theme={theme}>
                    {selected.render(fixture)}
                  </IframeShell>
                ) : builtState === 'loading' ? (
                  <Hint>Loading built bundle…</Hint>
                ) : builtState === 'missing' ? (
                  <Hint>
                    No built bundle found. Run{' '}
                    <code style={codeStyle}>npm run build:web</code> in
                    <code style={codeStyle}>mcp-server/</code> and reload.
                  </Hint>
                ) : builtHtml ? (
                  <IframeShell
                    mode="built"
                    width={width}
                    theme={theme}
                    srcHtml={builtHtml}
                  />
                ) : null}
              </div>
            </div>
          </div>
        </section>

        <details style={inspectorStyle}>
          <summary style={inspectorSummaryStyle}>Fixture data</summary>
          <pre style={inspectorPreStyle}>
            {JSON.stringify(fixture, null, 2)}
          </pre>
        </details>
      </main>
    </div>
  );
}

function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={groupStyle}>
      <div style={groupLabelStyle}>{label}</div>
      {children}
    </div>
  );
}

function SegGroup({ children }: { children: ReactNode }) {
  return <div style={segGroupStyle}>{children}</div>;
}

function SegBtn({
  active,
  onClick,
  children,
  title,
  isLast,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
  title?: string;
  isLast?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      style={{
        ...segBtnStyle,
        borderRight: isLast ? 'none' : segBtnStyle.borderRight,
        background: active ? SEG_ACTIVE_BG : 'transparent',
        color: active ? SEG_ACTIVE_FG : 'inherit',
      }}
    >
      {children}
    </button>
  );
}

function Hint({ children }: { children: ReactNode }) {
  return <div style={hintStyle}>{children}</div>;
}

/**
 * Mimics Claude Desktop's MCP tool header — the small "R rewind tool_name </>"
 * row that frames each component invocation. This isn't a perfect replica of
 * Claude's chrome, but it gives designers a real sense of how the component
 * is contextualized in production.
 */
function ToolHeader({
  producedBy,
  theme,
}: {
  producedBy: string;
  theme: Theme;
}) {
  const isDark = theme === 'dark';
  return (
    <div
      style={{
        ...toolHeaderStyle,
        color: isDark ? 'rgba(255,255,255,0.7)' : 'rgba(0,0,0,0.7)',
      }}
    >
      <div
        style={{
          ...appBadgeStyle,
          background: isDark ? '#1f1e1c' : '#ffffff',
          borderColor: isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.10)',
          color: isDark ? 'rgba(255,255,255,0.85)' : 'rgba(0,0,0,0.85)',
        }}
      >
        R
      </div>
      <span style={appNameStyle}>rewind</span>
      <span
        style={{
          ...toolNameStyle,
          color: isDark ? 'rgba(255,255,255,0.45)' : 'rgba(0,0,0,0.45)',
        }}
      >
        {producedBy}
      </span>
      <div style={{ flex: 1 }} />
      <span
        aria-hidden
        style={{
          ...codeIconStyle,
          color: isDark ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.5)',
        }}
      >
        {'</>'}
      </span>
    </div>
  );
}

function prettyVariant(v: string): string {
  const spaced = v.replace(/[-_]/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

const shellStyle = (theme: Theme): CSSProperties => ({
  display: 'grid',
  gridTemplateColumns: '240px 1fr',
  height: '100vh',
  width: '100vw',
  fontFamily: 'system-ui, -apple-system, sans-serif',
  color: '#111',
  // Match Claude Desktop's chat surface: #fcfcfc light, #1d1d1c dark.
  // Iframe page bg in host-styles.ts uses the same values so the
  // workbench feels continuous from shell → iframe → card.
  background: theme === 'dark' ? '#1d1d1c' : '#fcfcfc',
});

const navStyle: CSSProperties = {
  borderRight: '1px solid rgba(0,0,0,0.08)',
  background: '#fff',
  overflowY: 'auto',
  padding: '12px 8px',
};

const navHeaderStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: 0.6,
  opacity: 0.5,
  padding: '4px 8px 12px',
};

const navListStyle: CSSProperties = {
  listStyle: 'none',
  margin: 0,
  padding: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
};

const navButtonStyle: CSSProperties = {
  width: '100%',
  textAlign: 'left',
  padding: '8px 10px',
  border: 'none',
  borderRadius: 6,
  cursor: 'pointer',
  font: 'inherit',
  color: 'inherit',
};

const navSubStyle: CSSProperties = {
  fontSize: 11,
  opacity: 0.5,
  marginTop: 2,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
};

const mainStyle: CSSProperties = {
  display: 'grid',
  gridTemplateRows: 'auto 1fr auto',
  overflow: 'hidden',
};

const toolbarStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  gap: 16,
  padding: '10px 16px',
  borderBottom: '1px solid rgba(0,0,0,0.08)',
  background: '#fff',
  flexWrap: 'wrap',
};

const titleBlockStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  flexShrink: 0,
};

const mainTitleStyle: CSSProperties = {
  fontSize: 16,
  fontWeight: 600,
};

const mainSubStyle: CSSProperties = {
  fontSize: 11,
  opacity: 0.5,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
};

// Single source of truth for control height — every interactive element in
// the toolbar derives from this so heights can't drift.
const CTRL_H = 30;
const CTRL_BORDER = '1px solid rgba(0,0,0,0.14)';
const CTRL_RADIUS = 6;

const controlsStyle: CSSProperties = {
  display: 'flex',
  gap: 20,
  alignItems: 'flex-end',
  flexWrap: 'wrap',
};

const groupStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
};

const groupLabelStyle: CSSProperties = {
  fontSize: 10,
  fontWeight: 600,
  letterSpacing: 0.5,
  textTransform: 'uppercase',
  opacity: 0.5,
};

const rowStyle: CSSProperties = {
  display: 'flex',
  gap: 8,
  alignItems: 'center',
};

const segGroupStyle: CSSProperties = {
  display: 'inline-flex',
  height: CTRL_H,
  border: CTRL_BORDER,
  borderRadius: CTRL_RADIUS,
  overflow: 'hidden',
  background: '#fff',
};

const segBtnStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  height: '100%',
  padding: '0 14px',
  border: 'none',
  borderRight: '1px solid rgba(0,0,0,0.10)',
  fontSize: 12,
  fontWeight: 500,
  cursor: 'pointer',
  font: 'inherit',
  lineHeight: 1,
  minWidth: 56,
  // active background is applied per-button (see SegBtn) — using a softer
  // near-black instead of pure to avoid the heavy "dark mode" feel.
};

const SEG_ACTIVE_BG = '#27272a'; // zinc-800
const SEG_ACTIVE_FG = '#ffffff';

const inputStyle: CSSProperties = {
  height: CTRL_H,
  boxSizing: 'border-box',
  width: 72,
  padding: '0 10px',
  border: CTRL_BORDER,
  borderRadius: CTRL_RADIUS,
  background: '#fff',
  font: 'inherit',
  fontSize: 12,
  fontVariantNumeric: 'tabular-nums',
};

// Native macOS <select> ignores `height` and renders its own chrome height,
// so we reset appearance and draw our own chevron via SVG background.
const selectStyle: CSSProperties = {
  height: CTRL_H,
  boxSizing: 'border-box',
  padding: '0 30px 0 10px',
  border: CTRL_BORDER,
  borderRadius: CTRL_RADIUS,
  background:
    "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12' fill='none' stroke='%2371717a' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'><polyline points='2.5 4.5 6 8 9.5 4.5'/></svg>\") no-repeat right 10px center / 12px 12px, #fff",
  font: 'inherit',
  fontSize: 12,
  minWidth: 140,
  cursor: 'pointer',
  appearance: 'none',
  WebkitAppearance: 'none',
  MozAppearance: 'none',
  lineHeight: 1,
};

// Match Claude Desktop's chat surface so the preview reads like a real
// invocation. Same values as shellStyle and the iframe page bg —
// continuous shell -> preview -> iframe -> card.
const previewStyle = (theme: Theme): CSSProperties => ({
  overflow: 'auto',
  padding: '24px 16px',
  background: theme === 'dark' ? '#1d1d1c' : '#fcfcfc',
});

const previewWrapStyle: CSSProperties = {
  // height (not minHeight) so the iframe's `height: 100%` has a definite
  // parent to resolve against. Without this, iframes collapse to ~150px.
  height: '100%',
  display: 'flex',
  alignItems: 'stretch',
  justifyContent: 'center',
};

const componentFrameStyle: CSSProperties = {
  display: 'grid',
  gridTemplateRows: 'auto 1fr',
  height: '100%',
};

const iframeWrapStyle: CSSProperties = {
  minHeight: 0, // allow grid 1fr to shrink below content size
  display: 'flex',
  flexDirection: 'column',
};

const toolHeaderStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '4px 0 16px 0',
  fontSize: 13,
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", system-ui, sans-serif',
};

const appBadgeStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 22,
  height: 22,
  borderRadius: 6,
  border: '1px solid',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: 0.2,
  flexShrink: 0,
};

const appNameStyle: CSSProperties = {
  fontWeight: 500,
};

const toolNameStyle: CSSProperties = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 12,
};

const codeIconStyle: CSSProperties = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 13,
  letterSpacing: -0.5,
};

const hintStyle: CSSProperties = {
  alignSelf: 'center',
  margin: 'auto',
  padding: '24px 32px',
  borderRadius: 8,
  background: '#fff',
  border: '1px solid rgba(0,0,0,0.08)',
  fontSize: 13,
  color: '#444',
  maxWidth: 480,
  textAlign: 'center',
  lineHeight: 1.55,
};

const codeStyle: CSSProperties = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 12,
  background: 'rgba(0,0,0,0.06)',
  padding: '1px 5px',
  borderRadius: 3,
  margin: '0 2px',
};

const inspectorStyle: CSSProperties = {
  borderTop: '1px solid rgba(0,0,0,0.08)',
  background: '#fff',
  maxHeight: '40vh',
  overflowY: 'auto',
};

const inspectorSummaryStyle: CSSProperties = {
  padding: '8px 16px',
  fontSize: 12,
  fontWeight: 600,
  cursor: 'pointer',
  userSelect: 'none',
  opacity: 0.7,
};

const inspectorPreStyle: CSSProperties = {
  margin: 0,
  padding: '0 16px 12px',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 11,
  lineHeight: 1.5,
};
