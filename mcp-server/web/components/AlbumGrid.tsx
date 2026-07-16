import { useState, type CSSProperties } from 'react';
import { thumbhashToDataUrl } from '../lib/thumbhash.js';
import { legibleColor } from '../lib/legible-color.js';
import { cardOuterChrome, CARD_OUTER_CLASSNAME } from '../lib/card-tokens.js';
import { rewriteCdnImageUrl } from '../lib/cdn-image.js';
import { Sparkline } from './Sparkline.js';
import { type TopItem } from './AlbumCard.js';

const ROW_THUMB_PX = 56;
const ROW_THUMB_TX = `width=${ROW_THUMB_PX * 2},height=${ROW_THUMB_PX * 2},fit=cover,format=auto,quality=85`;

function buildRowThumbUrl(
  image: TopItem['image']
): { src: string; placeholder: string | null } | null {
  if (!image) return null;
  const base = image.cdn_url ?? image.url ?? null;
  if (!base) return null;
  const transformed = rewriteCdnImageUrl(base, ROW_THUMB_TX);
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

export function AlbumGrid({
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
        <h1 style={titleStyle}>Top albums</h1>
        {period && <div style={subtitleStyle}>{periodLabel(period)}</div>}
      </header>

      {items.length === 0 ? (
        <div style={emptyStyle}>No top albums in this window.</div>
      ) : (
        <ol style={listStyle}>
          {items.map((item) => (
            <li key={`${item.id}-${item.rank}`}>
              <AlbumRow item={item} onOpen={onOpen} />
            </li>
          ))}
        </ol>
      )}
    </article>
  );
}

function AlbumRow({
  item,
  onOpen,
}: {
  item: TopItem;
  onOpen?: (url: string) => void;
}) {
  const [loaded, setLoaded] = useState(false);
  const portrait = buildRowThumbUrl(item.image);
  const sparkColor = legibleColor(
    item.image?.accent_color ?? item.image?.dominant_color ?? null
  );
  const primaryUrl = item.apple_music_url ?? item.url ?? null;
  const clickable = primaryUrl != null;

  const Tag: 'button' | 'div' = clickable ? 'button' : 'div';
  return (
    <Tag
      type={clickable ? 'button' : undefined}
      onClick={clickable && primaryUrl ? () => onOpen?.(primaryUrl) : undefined}
      style={{ ...rowStyle, cursor: clickable ? 'pointer' : 'default' }}
      aria-label={
        clickable
          ? `Listen to ${item.name} by ${item.detail} on Apple Music`
          : `${item.name} by ${item.detail}`
      }
    >
      <span style={rowThumbStyle}>
        {portrait?.placeholder && (
          <img
            src={portrait.placeholder}
            alt=""
            aria-hidden
            style={{
              ...rowThumbImgStyle,
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
              ...rowThumbImgStyle,
              opacity: loaded ? 1 : 0,
            }}
          />
        )}
      </span>
      <span style={rowTextColStyle}>
        <span style={rowNameStyle}>{item.name}</span>
        <span style={rowSubStyle}>
          {item.detail} · {formatPlays(item.playcount)}
        </span>
      </span>
      {item.sparkline && item.sparkline.points.length > 1 && (
        <span style={rowSparklineStyle}>
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
  gap: 14,
  maxWidth: 720,
  margin: '0 auto',
  padding: '20px 22px 22px',
  ...cardOuterChrome,
  color: 'var(--color-text-primary, #1a1a1a)',
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
};

// Match TopTracks / TopArtists header type scale.
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

// ─── List view ─────────────────────────────────────────────────────

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
const rowThumbStyle: CSSProperties = {
  position: 'relative',
  width: ROW_THUMB_PX,
  height: ROW_THUMB_PX,
  borderRadius: 8,
  overflow: 'hidden',
  flexShrink: 0,
  border: '1px solid var(--color-border-tertiary, rgba(127,127,127,0.12))',
  background: 'rgba(127,127,127,0.06)',
  boxSizing: 'border-box',
};

const rowThumbImgStyle: CSSProperties = {
  position: 'absolute',
  inset: 0,
  width: '100%',
  height: '100%',
  objectFit: 'cover',
  transition: 'opacity 200ms ease',
};

const rowTextColStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  minWidth: 0,
  // Grow to absorb the row's free space so the trailing sparkline +
  // pill stay flush right.
  flex: 1,
};

const rowNameStyle: CSSProperties = {
  fontSize: 14,
  fontWeight: 600,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const rowSubStyle: CSSProperties = {
  fontSize: 12,
  opacity: 0.6,
  fontVariantNumeric: 'tabular-nums',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const rowSparklineStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'flex-end',
  alignItems: 'center',
  height: ROW_THUMB_PX,
  width: 64,
  flexShrink: 0,
  opacity: 0.4,
  paddingRight: 8,
};

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
