import { useState, type CSSProperties } from 'react';
import { thumbhashToDataUrl } from '../lib/thumbhash.js';

type Image = {
  cdn_url?: string | null;
  url?: string | null;
  thumbhash?: string | null;
  dominant_color?: string | null;
  accent_color?: string | null;
} | null;

export type TopTrackItem = {
  rank: number;
  id: number;
  name: string;
  detail: string;
  album_id?: number | null;
  album_name?: string | null;
  album_apple_music_url?: string | null;
  album_released_year?: number | null;
  album_total_tracks?: number | null;
  playcount: number;
  image: Image;
  url: string;
  apple_music_url: string | null;
  preview_url?: string | null;
};

export type TopTracksPayload = {
  period: string;
  artist_id: number | null;
  data: TopTrackItem[];
};

const TILE_PX = 160;
const TRANSFORM = `width=${TILE_PX * 2},height=${TILE_PX * 2},fit=cover,format=auto,quality=85`;

function buildSrc(
  image: Image
): { src: string; placeholder: string | null } | null {
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

export function TopTracksGrid({
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

  return (
    <section style={cardStyle}>
      <header style={headerStyle}>
        <h1 style={titleStyle}>{heading}</h1>
        <span style={periodStyle}>{periodLabel(payload.period)}</span>
      </header>
      <div style={gridStyle}>
        {payload.data.map((t) => (
          <Tile key={t.id} track={t} filtered={filtered} onOpen={onOpen} />
        ))}
      </div>
    </section>
  );
}

function Tile({
  track,
  filtered,
  onOpen,
}: {
  track: TopTrackItem;
  filtered: boolean;
  onOpen?: (url: string) => void;
}) {
  const [loaded, setLoaded] = useState(false);
  const src = buildSrc(track.image);
  const accent = track.image?.accent_color ?? 'rgba(127,127,127,0.18)';
  const dominant = track.image?.dominant_color ?? 'rgba(127,127,127,0.10)';
  const clickable = Boolean(track.apple_music_url);

  return (
    <button
      type="button"
      onClick={() => track.apple_music_url && onOpen?.(track.apple_music_url)}
      style={{
        ...tileStyle,
        cursor: clickable ? 'pointer' : 'default',
      }}
      aria-label={`${track.name} — ${track.playcount.toLocaleString()} plays`}
    >
      <div
        style={{
          ...artStyle,
          background: `linear-gradient(135deg, ${dominant} 0%, ${accent} 100%)`,
        }}
      >
        {src && src.placeholder && (
          <img
            src={src.placeholder}
            alt=""
            aria-hidden
            style={{
              ...artImgStyle,
              filter: 'blur(10px)',
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
              ...artImgStyle,
              opacity: loaded ? 1 : 0,
              transition: 'opacity 220ms ease',
            }}
          />
        )}
        <span style={rankBadgeStyle}>{track.rank}</span>
      </div>
      <div style={metaColStyle}>
        <div style={trackNameStyle}>{track.name}</div>
        <div style={trackSubStyle}>
          {filtered ? (track.album_name ?? '—') : track.detail}
        </div>
        <div style={playsStyle}>{track.playcount.toLocaleString()} plays</div>
      </div>
    </button>
  );
}

const cardStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 16,
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

const gridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
  gap: 14,
};

const tileStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  padding: 4,
  border: 'none',
  background: 'transparent',
  textAlign: 'left',
  font: 'inherit',
  color: 'inherit',
  borderRadius: 8,
};

const artStyle: CSSProperties = {
  width: '100%',
  aspectRatio: '1 / 1',
  borderRadius: 6,
  overflow: 'hidden',
  position: 'relative',
};

const artImgStyle: CSSProperties = {
  position: 'absolute',
  inset: 0,
  width: '100%',
  height: '100%',
  objectFit: 'cover',
  display: 'block',
};

const rankBadgeStyle: CSSProperties = {
  position: 'absolute',
  top: 6,
  left: 6,
  padding: '2px 8px',
  borderRadius: 999,
  background: 'rgba(0,0,0,0.55)',
  color: '#ffffff',
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: 0.4,
  backdropFilter: 'blur(6px)',
};

const metaColStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  padding: '0 2px',
};

const trackNameStyle: CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  lineHeight: 1.25,
  display: '-webkit-box',
  WebkitBoxOrient: 'vertical',
  WebkitLineClamp: 2,
  overflow: 'hidden',
  color: 'var(--color-text-primary, inherit)',
};

const trackSubStyle: CSSProperties = {
  fontSize: 12,
  opacity: 0.65,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const playsStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 500,
  opacity: 0.55,
  fontVariantNumeric: 'tabular-nums',
};
