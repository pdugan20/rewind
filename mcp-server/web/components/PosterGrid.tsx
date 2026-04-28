import { useMemo, useState, type CSSProperties } from 'react';
import { thumbhashToDataUrl } from '../lib/thumbhash.js';
import { timeAgo } from '../lib/time-ago.js';
import { cardOuterChrome } from '../lib/card-tokens.js';
import { type Watch } from './PosterCard.js';

const ROW_POSTER_W = 72;
const ROW_POSTER_H = 108; // 2:3 aspect

type Tab = 'reviewed' | 'watched';

// Dedup same movie shown multiple times in the window — keep only the
// most recent watch event so the list shows distinct films.
function dedupeByMovie(items: Watch[]): Watch[] {
  const seen = new Map<number, Watch>();
  for (const w of items) {
    const existing = seen.get(w.movie.id);
    if (
      !existing ||
      new Date(w.watched_at).getTime() > new Date(existing.watched_at).getTime()
    ) {
      seen.set(w.movie.id, w);
    }
  }
  const order = new Map<number, number>();
  items.forEach((w, i) => {
    if (!order.has(w.movie.id)) order.set(w.movie.id, i);
  });
  return Array.from(seen.values()).sort(
    (a, b) => (order.get(a.movie.id) ?? 0) - (order.get(b.movie.id) ?? 0)
  );
}

// Pull the user's Letterboxd handle out of any review_url we have so we
// can link the bottom CTA to their diary without hardcoding a username.
function deriveLetterboxdDiaryUrl(items: Watch[]): string | null {
  for (const w of items) {
    const u = w.review_url;
    if (!u) continue;
    const m = u.match(/^https?:\/\/letterboxd\.com\/([^/]+)\//);
    if (m) return `https://letterboxd.com/${m[1]}/films/diary/`;
  }
  return null;
}

export function PosterGrid({
  items,
  onOpen,
}: {
  items: Watch[];
  onOpen?: (url: string) => void;
}) {
  const rows = useMemo(() => dedupeByMovie(items), [items]);
  const reviewed = useMemo(() => rows.filter((w) => w.review), [rows]);
  const watched = useMemo(() => rows.filter((w) => !w.review), [rows]);
  const diaryUrl = useMemo(() => deriveLetterboxdDiaryUrl(items), [items]);

  // Tabs only render when both buckets have something — segmenting one
  // item is noise. When tabs are hidden we still render whichever bucket
  // has content so the card never collapses to empty unless the input is.
  const showTabs = reviewed.length > 0 && watched.length > 0;
  const [tab, setTab] = useState<Tab>(
    reviewed.length > 0 ? 'reviewed' : 'watched'
  );
  const list = !showTabs
    ? reviewed.length > 0
      ? reviewed
      : watched
    : tab === 'reviewed'
      ? reviewed
      : watched;

  const subtitle =
    items.length === 1
      ? '1 watched'
      : `${items.length.toLocaleString()} watched`;

  return (
    <article style={cardStyle}>
      <header style={headerStyle}>
        <h1 style={titleStyle}>Recent watches</h1>
        <div style={subtitleStyle}>{subtitle}</div>
      </header>

      {showTabs && (
        <TabToggle
          tab={tab}
          watchedCount={watched.length}
          reviewedCount={reviewed.length}
          onChange={setTab}
        />
      )}

      {rows.length === 0 ? (
        <div style={emptyStyle}>No watches in the selected window.</div>
      ) : (
        <ol style={listStyle}>
          {list.map((w) => (
            <li key={w.movie.id}>
              <WatchRow
                watch={w}
                // In the Reviewed tab we show the user's prose; in the
                // Watched tab we fall back to the film's summary, then
                // tagline, then nothing — never review (the bucket has
                // already filtered those out).
                bodyText={
                  w.review ?? w.movie.summary ?? w.movie.tagline ?? null
                }
                bodyKind={w.review ? 'review' : 'synopsis'}
                onOpen={onOpen}
              />
            </li>
          ))}
        </ol>
      )}

      {diaryUrl && (
        <div style={ctaWrapStyle}>
          <button
            type="button"
            onClick={() => onOpen?.(diaryUrl)}
            style={ctaButtonStyle}
          >
            View diary on Letterboxd ↗
          </button>
        </div>
      )}
    </article>
  );
}

function TabToggle({
  tab,
  watchedCount,
  reviewedCount,
  onChange,
}: {
  tab: Tab;
  watchedCount: number;
  reviewedCount: number;
  onChange: (t: Tab) => void;
}) {
  // Lead with Reviewed because that's where the user's prose lives —
  // matches the default-tab choice in PosterGrid.
  const tabs: Array<{ key: Tab; label: string; count: number }> = [
    { key: 'reviewed', label: 'Reviewed', count: reviewedCount },
    { key: 'watched', label: 'Watched', count: watchedCount },
  ];
  return (
    <div style={pillWrapStyle} role="tablist" aria-label="Filter">
      {tabs.map((t) => (
        <button
          key={t.key}
          type="button"
          role="tab"
          aria-selected={tab === t.key}
          onClick={() => onChange(t.key)}
          style={{
            ...pillButtonStyle,
            ...(tab === t.key
              ? pillButtonActiveStyle
              : pillButtonInactiveStyle),
          }}
        >
          {t.label}
          <span style={pillCountStyle}>{t.count}</span>
        </button>
      ))}
    </div>
  );
}

function WatchRow({
  watch,
  bodyText,
  bodyKind,
  onOpen,
}: {
  watch: Watch;
  bodyText: string | null;
  bodyKind: 'review' | 'synopsis';
  onOpen?: (url: string) => void;
}) {
  const { movie, user_rating, review_url, watched_at } = watch;
  const [loaded, setLoaded] = useState(false);
  const posterUrl = movie.image?.cdn_url ?? movie.image?.url ?? null;
  const placeholder = thumbhashToDataUrl(movie.image?.thumbhash ?? null);
  const clickable = review_url != null;

  const subParts: string[] = [];
  if (movie.year) subParts.push(String(movie.year));
  if (movie.director) subParts.push(movie.director);
  subParts.push(timeAgo(watched_at));

  const Tag: 'button' | 'div' = clickable ? 'button' : 'div';
  return (
    <Tag
      type={clickable ? 'button' : undefined}
      onClick={clickable && review_url ? () => onOpen?.(review_url) : undefined}
      style={{ ...rowStyle, cursor: clickable ? 'pointer' : 'default' }}
      aria-label={
        clickable ? `Open Letterboxd review for ${movie.title}` : movie.title
      }
    >
      {posterUrl ? (
        <span style={rowPosterStyle}>
          {placeholder && (
            <img
              src={placeholder}
              alt=""
              aria-hidden
              style={{
                ...posterImgStyle,
                filter: 'blur(8px)',
                opacity: loaded ? 0 : 1,
              }}
            />
          )}
          <img
            src={posterUrl}
            alt=""
            loading="lazy"
            onLoad={() => setLoaded(true)}
            style={{
              ...posterImgStyle,
              opacity: loaded ? 1 : 0,
            }}
          />
        </span>
      ) : (
        <span style={rowPosterStyle} aria-hidden />
      )}
      <span style={textColStyle}>
        <span style={titleRowStyle}>
          <span style={nameStyle}>{movie.title}</span>
          {user_rating != null && (
            <span style={starsColStyle} aria-label={`${user_rating} stars`}>
              <Stars value={user_rating} />
            </span>
          )}
        </span>
        <span style={subStyle}>{subParts.join(' · ')}</span>
        {bodyText && (
          <span style={bodyKind === 'review' ? reviewStyle : synopsisStyle}>
            {bodyText}
          </span>
        )}
      </span>
    </Tag>
  );
}

// Five-star row with half-star support. Filled/empty stars are the
// same SVG path; the half-star uses a clip-path on a duplicated
// filled glyph layered over an empty one.
function Stars({ value }: { value: number }) {
  const clamped = Math.max(0, Math.min(5, value));
  return (
    <span style={starsRowStyle}>
      {[0, 1, 2, 3, 4].map((i) => {
        const fill = Math.max(0, Math.min(1, clamped - i));
        return <Star key={i} fill={fill} />;
      })}
    </span>
  );
}

function Star({ fill }: { fill: number }) {
  const pct = `${Math.round(fill * 100)}%`;
  const path =
    'M9.5 1.5l2.47 5.01 5.53.8-4 3.9.94 5.5-4.94-2.6-4.94 2.6.94-5.5-4-3.9 5.53-.8L9.5 1.5z';
  return (
    <span style={starBoxStyle}>
      <svg viewBox="0 0 19 19" style={starSvgStyle} aria-hidden>
        <path d={path} fill="currentColor" opacity={0.18} />
      </svg>
      {fill > 0 && (
        <svg
          viewBox="0 0 19 19"
          style={{
            ...starSvgStyle,
            position: 'absolute',
            inset: 0,
            clipPath: `inset(0 ${100 - parseInt(pct, 10)}% 0 0)`,
          }}
          aria-hidden
        >
          <path d={path} fill="currentColor" opacity={0.45} />
        </svg>
      )}
    </span>
  );
}

// ─── Styles ─────────────────────────────────────────────────────────

const cardStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 14,
  maxWidth: 720,
  margin: '0 auto',
  padding: '20px 22px 22px',
  borderRadius: 12,
  ...cardOuterChrome,
  color: 'var(--color-text-primary, #1a1a1a)',
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
};

const headerStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
};

const titleStyle: CSSProperties = {
  margin: 0,
  fontSize: 22,
  fontWeight: 700,
  color: 'var(--color-text-primary, inherit)',
};

const subtitleStyle: CSSProperties = {
  fontSize: 14,
  fontWeight: 500,
  color: 'var(--color-text-secondary, inherit)',
  opacity: 0.75,
};

// ─── Tab toggle (matches the AlbumGrid pill toggle idiom) ──────────

const pillWrapStyle: CSSProperties = {
  display: 'flex',
  width: '100%',
  padding: 3,
  borderRadius: 999,
  background: 'rgba(127,127,127,0.08)',
};

const pillButtonStyle: CSSProperties = {
  flex: 1,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 6,
  fontSize: 13,
  fontWeight: 500,
  padding: '6px 0',
  border: 'none',
  borderRadius: 999,
  background: 'transparent',
  font: 'inherit',
  cursor: 'pointer',
  textAlign: 'center',
  transition: 'background 120ms ease, color 120ms ease',
};

const pillButtonActiveStyle: CSSProperties = {
  background: 'var(--color-background-primary, #fff)',
  color: 'var(--color-text-primary, inherit)',
  boxShadow: '0 1px 2px rgba(0,0,0,0.04)',
};

const pillButtonInactiveStyle: CSSProperties = {
  color: 'var(--color-text-secondary, inherit)',
  opacity: 0.7,
};

const pillCountStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 500,
  opacity: 0.55,
  fontVariantNumeric: 'tabular-nums',
};

// ─── List view ─────────────────────────────────────────────────────

const listStyle: CSSProperties = {
  listStyle: 'none',
  margin: 0,
  padding: 0,
  display: 'flex',
  flexDirection: 'column',
};

const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 16,
  width: '100%',
  padding: '8px 0',
  border: 'none',
  background: 'transparent',
  textAlign: 'left',
  font: 'inherit',
  color: 'inherit',
};

const rowPosterStyle: CSSProperties = {
  position: 'relative',
  width: ROW_POSTER_W,
  height: ROW_POSTER_H,
  // Match the canonical 8px radius used on every other thumb in the
  // workbench (album row, article thumb, etc.).
  borderRadius: 8,
  overflow: 'hidden',
  flexShrink: 0,
  background: 'rgba(127,127,127,0.06)',
  border: '1px solid var(--color-border-tertiary, rgba(127,127,127,0.12))',
  boxSizing: 'border-box',
};

const posterImgStyle: CSSProperties = {
  position: 'absolute',
  inset: 0,
  width: '100%',
  height: '100%',
  objectFit: 'cover',
  transition: 'opacity 200ms ease',
};

const textColStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  minWidth: 0,
  flex: 1,
  paddingTop: 2,
};

const titleRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  minWidth: 0,
};

const nameStyle: CSSProperties = {
  fontSize: 16,
  fontWeight: 600,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  flex: 1,
  minWidth: 0,
};

const subStyle: CSSProperties = {
  fontSize: 13,
  opacity: 0.6,
  fontVariantNumeric: 'tabular-nums',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const reviewStyle: CSSProperties = {
  fontSize: 14,
  lineHeight: 1.45,
  marginTop: 4,
  opacity: 0.85,
  display: '-webkit-box',
  WebkitBoxOrient: 'vertical',
  WebkitLineClamp: 2,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};

// Synopsis prose is TMDB boilerplate — dimmer than a user review so
// the two body kinds read differently when you flip between tabs.
const synopsisStyle: CSSProperties = {
  fontSize: 14,
  lineHeight: 1.45,
  marginTop: 4,
  opacity: 0.62,
  display: '-webkit-box',
  WebkitBoxOrient: 'vertical',
  WebkitLineClamp: 2,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};

const starsColStyle: CSSProperties = {
  flexShrink: 0,
  display: 'flex',
  alignItems: 'center',
};

const starsRowStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 0,
  color: 'var(--color-text-primary, currentColor)',
};

const starBoxStyle: CSSProperties = {
  position: 'relative',
  width: 13,
  height: 13,
  display: 'inline-block',
  flexShrink: 0,
};

const starSvgStyle: CSSProperties = {
  width: 13,
  height: 13,
  display: 'block',
};

const emptyStyle: CSSProperties = {
  padding: 24,
  textAlign: 'center',
  opacity: 0.6,
  fontSize: 14,
};

// ─── Bottom CTA ────────────────────────────────────────────────────

const ctaWrapStyle: CSSProperties = {
  display: 'flex',
  marginTop: 4,
};

// Full-width inverted pill — same idiom as ArticleDetail's "Read on X"
// and the artist card's "Listen on Apple Music" CTA. Inverts with
// theme: black-on-white in light mode, white-on-black in dark mode,
// driven by the host's text-primary / card-bg tokens. Falls back to
// hard #000/#fff if the host doesn't inject those vars.
const ctaButtonStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 8,
  width: '100%',
  padding: '12px 16px',
  borderRadius: 999,
  border: 'none',
  background: 'var(--color-text-primary, #000)',
  color: 'var(--card-bg, #fff)',
  cursor: 'pointer',
  font: 'inherit',
  fontSize: 15,
  fontWeight: 500,
  letterSpacing: 0.1,
};
