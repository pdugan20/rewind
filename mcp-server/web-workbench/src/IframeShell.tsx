import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { themeStyleSheet, type Theme } from './themes/host-styles';

const STYLE_ID = 'workbench-theme';
const EMPTY_DOC = '<!doctype html><html><head></head><body></body></html>';

type Props = {
  /** Pixel width of the iframe (height fills the container). */
  width: number;
  theme: Theme;
} & (
  | { mode: 'hmr'; children: ReactNode; srcHtml?: never }
  | { mode: 'built'; srcHtml: string; children?: never }
);

/**
 * Renders the preview inside a sandboxed iframe — the same surface MCP UI
 * components meet in production. HMR mode portals React children into the
 * iframe body so edits hot-reload. Built mode loads the inlined HTML bundle
 * the worker would actually serve.
 *
 * `allow-same-origin` is intentional in both modes so we can inject host
 * theme variables. Claude Desktop's real sandbox is stricter; the workbench
 * trades a touch of fidelity for the ability to swap themes without a
 * rebuild.
 */
export function IframeShell(props: Props) {
  const { width, theme, mode } = props;
  const ref = useRef<HTMLIFrameElement>(null);
  const [iframeBody, setIframeBody] = useState<HTMLElement | null>(null);

  // (re)attach on every mode/src change — the `key` on the iframe forces
  // a fresh document, so we need to re-find body and re-inject styles.
  useEffect(() => {
    const iframe = ref.current;
    if (!iframe) return;

    let cancelled = false;

    const onReady = () => {
      if (cancelled) return;
      const doc = iframe.contentDocument;
      if (!doc) return;
      injectTheme(doc, theme);
      if (mode === 'hmr') setIframeBody(doc.body);
    };

    // The iframe may already have loaded by the time this effect runs
    // (srcDoc is synchronous in some browsers). Try once immediately,
    // and also listen for the load event.
    if (iframe.contentDocument?.readyState === 'complete') {
      onReady();
    }
    iframe.addEventListener('load', onReady);
    return () => {
      cancelled = true;
      iframe.removeEventListener('load', onReady);
    };
    // mode + srcHtml in deps so the effect re-runs after the iframe remounts
    // via the key= prop below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, props.mode === 'built' ? props.srcHtml : null]);

  // Patch theme on the existing document without remounting the iframe.
  useEffect(() => {
    const doc = ref.current?.contentDocument;
    if (doc) injectTheme(doc, theme);
  }, [theme]);

  const initialSrc = mode === 'hmr' ? EMPTY_DOC : props.srcHtml;
  // Force a fresh iframe whenever we swap modes or the built HTML changes.
  const remountKey =
    mode === 'hmr' ? 'hmr' : `built:${hashFingerprint(props.srcHtml)}`;

  return (
    <>
      <iframe
        ref={ref}
        key={remountKey}
        sandbox="allow-scripts allow-same-origin"
        srcDoc={initialSrc}
        style={{ ...iframeStyle, width }}
        title="MCP UI preview"
      />
      {mode === 'hmr' && iframeBody && createPortal(props.children, iframeBody)}
    </>
  );
}

function injectTheme(doc: Document, theme: Theme): void {
  let style = doc.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!style) {
    style = doc.createElement('style');
    style.id = STYLE_ID;
    doc.head.appendChild(style);
  }
  // host-styles.ts now defines `--card-bg` and `--card-border` per
  // theme — that drives the toggle correctly. The card-tokens.ts
  // module-side-effect (which uses `prefers-color-scheme: dark`)
  // is for production where iOS / Desktop reflect the OS theme,
  // not for the workbench's manual toggle.
  style.textContent = themeStyleSheet(theme);
}

function hashFingerprint(s: string): string {
  // Cheap, stable-enough fingerprint for keying. We just need different
  // builds to remount; collisions on similar HTML aren't catastrophic.
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return String(h);
}

// No shadow / no rounded border — the iframe blends into the parent surface
// so it looks like the component is sitting directly on Claude's cream bg,
// not floating on a white card.
const iframeStyle: CSSProperties = {
  border: 'none',
  height: '100%',
  background: 'transparent',
  display: 'block',
};
