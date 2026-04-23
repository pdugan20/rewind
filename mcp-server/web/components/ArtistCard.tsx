import { useState, type CSSProperties } from 'react';
import { thumbhashToDataUrl } from '../lib/thumbhash.js';
import type { TopItem } from './AlbumCard.js';

const PORTRAIT_PX = 140;
const CDN_TRANSFORM = `width=${PORTRAIT_PX * 2},height=${PORTRAIT_PX * 2},fit=cover,format=auto,quality=85`;

function buildPortraitUrl(
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

export function ArtistCard({
  item,
  onOpen,
}: {
  item: TopItem;
  onOpen?: (url: string) => void;
}) {
  const clickable = item.apple_music_url != null;
  const [loaded, setLoaded] = useState(false);
  const [hovered, setHovered] = useState(false);

  const portrait = buildPortraitUrl(item.image);
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
      }}
      aria-label={clickable ? `Open ${item.name} on Apple Music` : item.name}
    >
      <div
        style={{
          position: 'relative',
          width: '100%',
          aspectRatio: '1 / 1',
          borderRadius: '50%',
          overflow: 'hidden',
          background: dominant,
          boxShadow: hovered ? hoverShadow : restShadow,
          transition: 'box-shadow 150ms ease',
        }}
      >
        {portrait?.placeholder && (
          <img
            src={portrait.placeholder}
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
        {portrait?.src && (
          <img
            src={portrait.src}
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
      </div>
      <div style={metaStyle}>
        <div style={rankStyle}>#{item.rank}</div>
        <div style={titleStyle}>{item.name}</div>
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
  alignItems: 'center',
  gap: 8,
  padding: 6,
  border: 'none',
  background: 'transparent',
  textAlign: 'center',
  font: 'inherit',
  color: 'inherit',
  transition: 'transform 150ms ease',
  willChange: 'transform',
};

const restShadow = '0 1px 3px rgba(0,0,0,0.12), 0 2px 8px rgba(0,0,0,0.08)';
const hoverShadow = '0 4px 10px rgba(0,0,0,0.18), 0 8px 24px rgba(0,0,0,0.18)';

const metaStyle: CSSProperties = {
  fontSize: 12,
  lineHeight: 1.3,
  width: '100%',
};

const rankStyle: CSSProperties = {
  fontSize: 10,
  fontWeight: 600,
  opacity: 0.5,
  letterSpacing: 0.3,
};

const titleStyle: CSSProperties = {
  fontWeight: 600,
  marginTop: 2,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const playsStyle: CSSProperties = {
  opacity: 0.55,
  fontSize: 11,
  marginTop: 2,
};
