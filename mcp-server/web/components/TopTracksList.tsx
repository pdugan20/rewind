import { useState, type CSSProperties } from 'react';
import { thumbhashToDataUrl } from '../lib/thumbhash.js';
import type { TopTrackItem, TopTracksPayload } from './TopTracksGrid.js';

export type { TopTrackItem, TopTracksPayload };

const THUMB_PX = 44;
const TRANSFORM = `width=${THUMB_PX * 2},height=${THUMB_PX * 2},fit=cover,format=auto,quality=85`;

function buildSrc(image: TopTrackItem['image']) {
  if (!image) return null;
  const base = image.cdn_url ?? image.url ?? null;
  if (!base) return null;
  const transformed = base.includes('?')
    ? `${base.split('?')[0]}?${TRANSFORM}`
    : `${base}?${TRANSFORM}`;
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
      return 'All time';
    default:
      return period;
  }
}

export function TopTracksList({
  payload,
  onOpen,
}: {
  payload: TopTracksPayload;
  onOpen?: (url: string) => void;
}) {
  const filtered = payload.artist_id !== null && payload.data.length > 0;
  const heading = filtered
    ? `Top ${payload.data[0].detail} tracks`
    : 'Top tracks';
  const maxPlaycount = Math.max(...payload.data.map((t) => t.playcount), 1);

  return (
    <section style={cardStyle}>
      <header style={headerStyle}>
        <h1 style={titleStyle}>{heading}</h1>
        <span style={periodStyle}>{periodLabel(payload.period)}</span>
      </header>
      <ol style={listStyle}>
        {payload.data.map((t) => (
          <Row
            key={t.id}
            track={t}
            filtered={filtered}
            maxPlaycount={maxPlaycount}
            onOpen={onOpen}
          />
        ))}
      </ol>
    </section>
  );
}

function Row({
  track,
  filtered,
  maxPlaycount,
  onOpen,
}: {
  track: TopTrackItem;
  filtered: boolean;
  maxPlaycount: number;
  onOpen?: (url: string) => void;
}) {
  const [loaded, setLoaded] = useState(false);
  const src = buildSrc(track.image);
  const accent = track.image?.accent_color ?? 'var(--color-accent, #4c6ef5)';
  const dominant = track.image?.dominant_color ?? 'rgba(127,127,127,0.10)';
  const sub = filtered ? track.album_name : track.detail;
  const clickable = Boolean(track.apple_music_url);
  const barPct = (track.playcount / maxPlaycount) * 100;

  return (
    <li style={rowStyle}>
      <span style={rankStyle}>{track.rank}</span>
      <div
        style={{
          width: THUMB_PX,
          height: THUMB_PX,
          borderRadius: 4,
          overflow: 'hidden',
          flexShrink: 0,
          background: dominant,
          position: 'relative',
        }}
      >
        {src && src.placeholder && (
          <img
            src={src.placeholder}
            alt=""
            aria-hidden
            style={{
              position: 'absolute',
              inset: 0,
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              filter: 'blur(8px)',
              transform: 'scale(1.05)',
              opacity: loaded ? 0 : 1,
              transition: 'opacity 180ms ease',
            }}
          />
        )}
        {src && (
          <img
            src={src.src}
            alt=""
            loading="lazy"
            onLoad={() => setLoaded(true)}
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              opacity: loaded ? 1 : 0,
              transition: 'opacity 200ms ease',
            }}
          />
        )}
      </div>
      <div style={textColStyle}>
        <button
          type="button"
          onClick={() =>
            track.apple_music_url && onOpen?.(track.apple_music_url)
          }
          style={{
            ...nameStyle,
            cursor: clickable ? 'pointer' : 'default',
          }}
        >
          {track.name}
        </button>
        {sub && <div style={subStyle}>{sub}</div>}
      </div>
      <div style={countColStyle}>
        <span style={countStyle}>{track.playcount.toLocaleString()}</span>
        <div style={barTrackStyle}>
          <div
            style={{
              ...barFillStyle,
              width: `${barPct}%`,
              background: accent,
            }}
          />
        </div>
      </div>
    </li>
  );
}

const cardStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 14,
  maxWidth: 720,
  margin: '0 auto',
  padding: '20px 22px 22px',
  borderRadius: 12,
  border: '1px solid var(--color-border-tertiary, rgba(127,127,127,0.12))',
  background: 'var(--color-background-primary, transparent)',
};

const headerStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'baseline',
  gap: 12,
};

const titleStyle: CSSProperties = {
  fontSize: 22,
  fontWeight: 700,
  margin: 0,
  color: 'var(--color-text-primary, inherit)',
};

const periodStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 500,
  letterSpacing: 0.4,
  textTransform: 'uppercase',
  opacity: 0.55,
};

const listStyle: CSSProperties = {
  margin: 0,
  padding: 0,
  listStyle: 'none',
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
};

const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  padding: '6px 4px',
  borderRadius: 6,
};

const rankStyle: CSSProperties = {
  width: 26,
  textAlign: 'right',
  fontSize: 14,
  fontWeight: 700,
  fontVariantNumeric: 'tabular-nums',
  opacity: 0.45,
  flexShrink: 0,
};

const textColStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 1,
};

const nameStyle: CSSProperties = {
  fontSize: 14,
  fontWeight: 500,
  lineHeight: 1.3,
  border: 'none',
  background: 'transparent',
  padding: 0,
  textAlign: 'left',
  font: 'inherit',
  color: 'inherit',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const subStyle: CSSProperties = {
  fontSize: 12,
  opacity: 0.55,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const countColStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-end',
  gap: 4,
  width: 110,
  flexShrink: 0,
};

const countStyle: CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  fontVariantNumeric: 'tabular-nums',
};

const barTrackStyle: CSSProperties = {
  height: 3,
  width: '100%',
  background: 'rgba(127,127,127,0.18)',
  borderRadius: 2,
  overflow: 'hidden',
};

const barFillStyle: CSSProperties = {
  height: '100%',
  borderRadius: 2,
  transition: 'width 240ms ease',
};
