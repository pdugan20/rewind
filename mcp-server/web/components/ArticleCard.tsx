import { useState, type CSSProperties } from 'react';
import { thumbhashToDataUrl } from '../lib/thumbhash.js';
import { timeAgo } from '../lib/time-ago.js';

export type Article = {
  id: number;
  title: string;
  author: string | null;
  url: string | null;
  instapaper_url: string | null;
  instapaper_app_url: string | null;
  domain: string | null;
  description: string | null;
  estimated_read_min: number | null;
  status: string;
  progress: number;
  image: {
    cdn_url?: string | null;
    url?: string | null;
    thumbhash?: string | null;
    dominant_color?: string | null;
    accent_color?: string | null;
  } | null;
  saved_at: string;
};

const THUMB_PX = 80;
// 2x for retina displays.
const CDN_TRANSFORM = `width=${THUMB_PX * 2},height=${THUMB_PX * 2},fit=cover,format=auto,quality=85`;

function buildThumbUrl(
  image: Article['image']
): { src: string; placeholder: string | null } | null {
  if (!image) return null;
  const base = image.cdn_url ?? image.url ?? null;
  if (!base) return null;
  // If the CDN URL already carries query params from the API, preserve them
  // but override the width/height/fit with our tile size.
  const transformed = base.includes('?')
    ? `${base.split('?')[0]}?${CDN_TRANSFORM}`
    : `${base}?${CDN_TRANSFORM}`;
  return {
    src: transformed,
    placeholder: thumbhashToDataUrl(image.thumbhash ?? null),
  };
}

export function ArticleCard({
  article,
  onOpen,
}: {
  article: Article;
  onOpen?: (url: string) => void;
}) {
  const primaryUrl = article.instapaper_url ?? article.url ?? null;
  const clickable = primaryUrl != null;
  const [hovered, setHovered] = useState(false);

  const thumb = buildThumbUrl(article.image);
  const accent = article.image?.accent_color ?? '#e5e5e5';
  const dominant = article.image?.dominant_color ?? '#d4d4d4';

  const meta = [
    article.domain,
    article.estimated_read_min
      ? `${article.estimated_read_min} min read`
      : null,
    timeAgo(article.saved_at),
  ]
    .filter(Boolean)
    .join(' · ');

  const blurb = article.description ?? '';

  const Tag: 'button' | 'div' = clickable ? 'button' : 'div';

  return (
    <Tag
      type={clickable ? 'button' : undefined}
      onClick={clickable && primaryUrl ? () => onOpen?.(primaryUrl) : undefined}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        ...cardStyle,
        cursor: clickable ? 'pointer' : 'default',
        background: hovered
          ? 'var(--color-background-secondary, rgba(127,127,127,0.05))'
          : 'transparent',
      }}
      aria-label={
        clickable ? `Open ${article.title} in Instapaper` : article.title
      }
    >
      <div style={textColStyle}>
        <div style={titleStyle}>{article.title}</div>
        <div style={metaStyle}>{meta}</div>
        {blurb && <div style={blurbStyle}>{blurb}</div>}
      </div>
      <Thumbnail
        thumb={thumb}
        accent={accent}
        dominant={dominant}
        domain={article.domain}
      />
    </Tag>
  );
}

function Thumbnail({
  thumb,
  accent,
  dominant,
  domain,
}: {
  thumb: { src: string; placeholder: string | null } | null;
  accent: string;
  dominant: string;
  domain: string | null;
}) {
  const [loaded, setLoaded] = useState(false);

  if (!thumb) {
    // No OG image — fallback tile with accent color + domain text.
    return (
      <div
        style={{
          ...thumbBaseStyle,
          background: accent,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 6,
        }}
      >
        <span style={fallbackLabelStyle}>{domain ?? ''}</span>
      </div>
    );
  }

  return (
    <div
      style={{
        ...thumbBaseStyle,
        background: dominant,
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      {thumb.placeholder && (
        <img
          src={thumb.placeholder}
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
      <img
        src={thumb.src}
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
    </div>
  );
}

const cardStyle: CSSProperties = {
  display: 'flex',
  gap: 16,
  alignItems: 'flex-start',
  padding: '14px 12px',
  border: 'none',
  borderBottom:
    '1px solid var(--color-border-tertiary, rgba(127,127,127,0.12))',
  width: '100%',
  textAlign: 'left',
  font: 'inherit',
  color: 'inherit',
  background: 'transparent',
  transition: 'background 120ms ease',
};

const textColStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
};

const titleStyle: CSSProperties = {
  fontSize: 16,
  fontWeight: 600,
  lineHeight: 1.3,
  display: '-webkit-box',
  WebkitBoxOrient: 'vertical',
  WebkitLineClamp: 2,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  color: 'var(--color-text-primary, inherit)',
};

const metaStyle: CSSProperties = {
  fontSize: 13,
  opacity: 0.55,
  color: 'var(--color-text-secondary, inherit)',
};

const blurbStyle: CSSProperties = {
  fontSize: 14,
  lineHeight: 1.4,
  opacity: 0.75,
  display: '-webkit-box',
  WebkitBoxOrient: 'vertical',
  WebkitLineClamp: 2,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  color: 'var(--color-text-secondary, inherit)',
};

const thumbBaseStyle: CSSProperties = {
  width: 80,
  height: 80,
  flexShrink: 0,
  borderRadius: 8,
  overflow: 'hidden',
};

const fallbackLabelStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  textAlign: 'center',
  color: '#ffffff',
  mixBlendMode: 'normal',
  textShadow: '0 1px 2px rgba(0,0,0,0.35)',
  letterSpacing: 0.3,
  wordBreak: 'break-word',
  lineHeight: 1.2,
};
