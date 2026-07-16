import { useState, type CSSProperties } from 'react';
import { thumbhashToDataUrl } from '../lib/thumbhash.js';
import { cardOuterChrome, CARD_OUTER_CLASSNAME } from '../lib/card-tokens.js';
import { rewriteCdnImageUrl } from '../lib/cdn-image.js';
import { Sparkline } from './Sparkline.js';
import type { TopItem } from './AlbumCard.js';

const THUMB_PX = 44;
const THUMB_TX = `width=${THUMB_PX * 2},height=${THUMB_PX * 2},fit=cover,format=auto,quality=85`;

function buildThumbUrl(
  image: TopItem['image']
): { src: string; placeholder: string | null } | null {
  if (!image) return null;
  const base = image.cdn_url ?? image.url ?? null;
  if (!base) return null;
  const transformed = rewriteCdnImageUrl(base, THUMB_TX);
  return {
    src: transformed,
    placeholder: thumbhashToDataUrl(image.thumbhash ?? null),
  };
}

function periodLabel(period: string): string {
  switch (period) {
    case '7day':
      return 'Last 7 days';
    case '1month':
      return 'Last month';
    case '3month':
      return 'Last 3 months';
    case '6month':
      return 'Last 6 months';
    case '12month':
      return 'Last 12 months';
    case 'overall':
    case 'all_time':
      return 'All time';
    default:
      return period;
  }
}

export function ArtistGrid({
  items,
  period,
  onOpen,
}: {
  items: TopItem[];
  // Optional for backward compat with any caller still using positional
  // items. When absent the header skips the period subline.
  period?: string;
  onOpen?: (url: string) => void;
}) {
  return (
    <article className={CARD_OUTER_CLASSNAME} style={cardStyle}>
      <header style={headerStyle}>
        <h1 style={titleStyle}>Top artists</h1>
        {period && <div style={subtitleStyle}>{periodLabel(period)}</div>}
      </header>
      {items.length === 0 ? (
        <div style={emptyStyle}>No top artists in this window.</div>
      ) : (
        <ol style={listStyle}>
          {items.map((item) => (
            <li key={`${item.id}-${item.rank}`}>
              <ArtistRow item={item} onOpen={onOpen} />
            </li>
          ))}
        </ol>
      )}
    </article>
  );
}

function ArtistRow({
  item,
  onOpen,
}: {
  item: TopItem;
  onOpen?: (url: string) => void;
}) {
  const [loaded, setLoaded] = useState(false);
  const portrait = buildThumbUrl(item.image);
  // Sparkline color is uniform across the list — `currentColor`
  // inherits the row's text color (theme-adaptive) so the trends
  // read as one consistent visual rhythm down the rail rather than
  // a noisy spread of brand colors.
  const sparkColor = 'currentColor';
  // Apple Music is the canonical "Listen" target; fall back to Last.fm
  // so the row still works for artists we haven't matched yet.
  const primaryUrl = item.apple_music_url ?? item.url ?? null;
  const clickable = primaryUrl != null;

  // The whole row is the click target — the Listen pill is a visual
  // affordance, not a separate button (avoids nested-interactive).
  const Tag: 'button' | 'div' = clickable ? 'button' : 'div';
  return (
    <Tag
      type={clickable ? 'button' : undefined}
      onClick={clickable && primaryUrl ? () => onOpen?.(primaryUrl) : undefined}
      style={{ ...rowStyle, cursor: clickable ? 'pointer' : 'default' }}
      aria-label={
        clickable ? `Listen to ${item.name} on Apple Music` : item.name
      }
    >
      <span style={thumbStyle}>
        {portrait?.placeholder && (
          <img
            src={portrait.placeholder}
            alt=""
            aria-hidden
            style={{
              ...thumbImgStyle,
              filter: 'blur(8px)',
              opacity: loaded ? 0 : 1,
            }}
          />
        )}
        {portrait?.src && (
          <img
            src={portrait.src}
            alt=""
            loading="lazy"
            onLoad={() => setLoaded(true)}
            style={{
              ...thumbImgStyle,
              opacity: loaded ? 1 : 0,
            }}
          />
        )}
      </span>
      <span style={textColStyle}>
        <span style={nameStyle}>{item.name}</span>
        <span style={playsStyle}>{formatPlays(item.playcount)}</span>
      </span>
      {item.sparkline && item.sparkline.points.length > 1 && (
        <span style={sparklineStyle}>
          <Sparkline
            points={item.sparkline.points}
            color={sparkColor}
            ariaLabel={`Plays over time for ${item.name}`}
          />
        </span>
      )}
      {clickable && <span style={listenPillStyle}>Listen ↗</span>}
    </Tag>
  );
}

function formatPlays(n: number): string {
  if (n === 1) return '1 play';
  return `${n.toLocaleString()} plays`;
}

// ─── Styles ─────────────────────────────────────────────────────────

const cardStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 18,
  maxWidth: 720,
  margin: '0 auto',
  padding: '20px 22px 14px',
  ...cardOuterChrome,
  color: 'var(--color-text-primary, #1a1a1a)',
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
};

// Match TopTracks header type scale exactly so all "list" surfaces
// share one lockup pattern.
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

const listStyle: CSSProperties = {
  listStyle: 'none',
  margin: 0,
  padding: 0,
  display: 'flex',
  flexDirection: 'column',
};

const rowStyle: CSSProperties = {
  // Flex (not grid) — so a missing sparkline cell doesn't leave a
  // phantom track + gap reserved on the right of the pill.
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  width: '100%',
  padding: '8px 0',
  border: 'none',
  background: 'transparent',
  textAlign: 'left',
  font: 'inherit',
  color: 'inherit',
};

// Same canonical border color we use on every other card chrome
// in the system. No brand-color background — neutral until the
// image loads, then the image covers it.
const thumbStyle: CSSProperties = {
  position: 'relative',
  width: THUMB_PX,
  height: THUMB_PX,
  borderRadius: '50%',
  overflow: 'hidden',
  flexShrink: 0,
  border: '1px solid var(--color-border-tertiary, rgba(127,127,127,0.12))',
  background: 'rgba(127,127,127,0.06)',
  boxSizing: 'border-box',
};

const thumbImgStyle: CSSProperties = {
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
  gap: 2,
  minWidth: 0,
  // Grow to absorb the row's free space so the trailing sparkline +
  // pill stay flush right.
  flex: 1,
};

const nameStyle: CSSProperties = {
  fontSize: 14,
  fontWeight: 600,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const playsStyle: CSSProperties = {
  fontSize: 12,
  opacity: 0.6,
  fontVariantNumeric: 'tabular-nums',
};

const sparklineStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'flex-end',
  alignItems: 'center',
  height: THUMB_PX,
  // Explicit width + flex-shrink:0 so iOS WebKit doesn't collapse the
  // <span> when the row's text column claims all the free space — the
  // SVG's intrinsic width attribute alone doesn't establish the flex
  // basis reliably on mobile.
  width: 64,
  flexShrink: 0,
  opacity: 0.4,
  paddingRight: 8,
};

// Inverted variant: white pill with hairline border. Visual affordance
// only — the whole row is the click target so this is a span, not a
// nested button.
const listenPillStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  fontSize: 12,
  fontWeight: 500,
  padding: '6px 12px',
  borderRadius: 999,
  background: '#fff',
  color: '#000',
  border: '1px solid rgba(0,0,0,0.12)',
  flexShrink: 0,
  whiteSpace: 'nowrap',
};

const emptyStyle: CSSProperties = {
  padding: 24,
  textAlign: 'center',
  opacity: 0.6,
  fontSize: 14,
};
