import { useState, type CSSProperties } from 'react';
import { thumbhashToDataUrl } from '../lib/thumbhash.js';

export type TopItem = {
  rank: number;
  id: number;
  name: string;
  detail: string; // artist name for albums, genre/short desc for artists
  playcount: number;
  image: {
    cdn_url?: string | null;
    url?: string | null;
    thumbhash?: string | null;
    dominant_color?: string | null;
    accent_color?: string | null;
  } | null;
  url: string;
  apple_music_url: string | null;
  preview_url?: string | null;
};

const COVER_PX = 180;
const CDN_TRANSFORM = `width=${COVER_PX * 2},height=${COVER_PX * 2},fit=cover,format=auto,quality=85`;

function buildCoverUrl(
  image: TopItem['image']
): { src: string; placeholder: string | null } | null {
  if (!image) return null;
  const base = image.cdn_url ?? image.url ?? null;
  if (!base) return null;
  const transformed = base.includes('?')
    ? `${base.split('?')[0]}?${CDN_TRANSFORM}`
    : `${base}?${CDN_TRANSFORM}`;
  return {
    src: transformed,
    placeholder: thumbhashToDataUrl(image.thumbhash ?? null),
  };
}

export function AlbumCard({
  item,
  onOpen,
}: {
  item: TopItem;
  onOpen?: (url: string) => void;
}) {
  const clickable = item.apple_music_url != null;
  const [loaded, setLoaded] = useState(false);
  const [hovered, setHovered] = useState(false);

  const cover = buildCoverUrl(item.image);
  const dominant = item.image?.dominant_color ?? '#222';

  const Tag: 'button' | 'div' = clickable ? 'button' : 'div';

  return (
    <Tag
      type={clickable ? 'button' : undefined}
      onClick={
        clickable && item.apple_music_url
          ? () => onOpen?.(item.apple_music_url!)
          : undefined
      }
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        ...cardStyle,
        cursor: clickable ? 'pointer' : 'default',
        transform: hovered ? 'translateY(-2px)' : 'translateY(0)',
        boxShadow: hovered ? hoverShadow : restShadow,
      }}
      aria-label={
        clickable
          ? `Open ${item.name} on Apple Music`
          : `${item.name} by ${item.detail}`
      }
    >
      <div
        style={{
          position: 'relative',
          aspectRatio: '1 / 1',
          background: dominant,
        }}
      >
        {cover?.placeholder && (
          <img
            src={cover.placeholder}
            alt=""
            aria-hidden
            style={{
              position: 'absolute',
              inset: 0,
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              filter: 'blur(12px)',
              transform: 'scale(1.05)',
              opacity: loaded ? 0 : 1,
              transition: 'opacity 180ms ease',
            }}
          />
        )}
        {cover?.src && (
          <img
            src={cover.src}
            alt=""
            loading="lazy"
            onLoad={() => setLoaded(true)}
            style={{
              position: 'relative',
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              display: 'block',
              opacity: loaded ? 1 : 0,
              transition: 'opacity 200ms ease',
            }}
          />
        )}
        <span style={rankBadge}>#{item.rank}</span>
      </div>
      <div style={metaStyle}>
        <div style={titleStyle}>{item.name}</div>
        <div style={subStyle}>{item.detail}</div>
        <div style={playsStyle}>{formatPlays(item.playcount)}</div>
      </div>
    </Tag>
  );
}

function formatPlays(n: number): string {
  if (n === 1) return '1 play';
  return `${n.toLocaleString()} plays`;
}

const cardStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  borderRadius: 8,
  overflow: 'hidden',
  border: '1px solid var(--color-border-tertiary, rgba(127,127,127,0.15))',
  background: 'var(--color-background-secondary, transparent)',
  textAlign: 'left',
  padding: 0,
  font: 'inherit',
  color: 'inherit',
  transition: 'transform 150ms ease, box-shadow 150ms ease',
  willChange: 'transform',
};

const restShadow = '0 1px 2px rgba(0,0,0,0.08), 0 2px 8px rgba(0,0,0,0.12)';
const hoverShadow = '0 4px 10px rgba(0,0,0,0.18), 0 8px 24px rgba(0,0,0,0.18)';

const metaStyle: CSSProperties = {
  padding: '8px 10px 10px',
  fontSize: 12,
  lineHeight: 1.3,
};

const titleStyle: CSSProperties = {
  fontWeight: 600,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const subStyle: CSSProperties = {
  opacity: 0.7,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const playsStyle: CSSProperties = {
  opacity: 0.5,
  fontSize: 11,
  marginTop: 2,
};

const rankBadge: CSSProperties = {
  position: 'absolute',
  top: 6,
  left: 6,
  background: 'rgba(0,0,0,0.65)',
  color: '#fff',
  fontSize: 10,
  fontWeight: 600,
  padding: '2px 6px',
  borderRadius: 4,
  letterSpacing: 0.3,
};
