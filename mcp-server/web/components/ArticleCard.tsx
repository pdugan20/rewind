import { useState, type CSSProperties } from 'react';
import { thumbhashToDataUrl } from '../lib/thumbhash.js';
import { timeAgo } from '../lib/time-ago.js';
import { rewriteCdnImageUrl } from '../lib/cdn-image.js';

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
  const transformed = rewriteCdnImageUrl(base, CDN_TRANSFORM);
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
  // Primary click goes to the real source URL so users land on the
  // actual article. instapaper_url doesn't deep-link into the iOS app
  // from Desktop; it just opens instapaper.com/read/:id in a browser,
  // which is rarely what the user wants when they're already in a
  // desktop chat.
  const primaryUrl = article.url ?? article.instapaper_url ?? null;
  const clickable = primaryUrl != null;

  const thumb = buildThumbUrl(article.image);

  const meta = [
    article.author,
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
      style={{
        ...cardStyle,
        cursor: clickable ? 'pointer' : 'default',
      }}
      aria-label={clickable ? `Open ${article.title}` : article.title}
    >
      <div style={textColStyle}>
        <div style={titleStyle}>{article.title}</div>
        <div style={metaStyle}>{meta}</div>
        {blurb && <div style={blurbStyle}>{blurb}</div>}
      </div>
      {thumb && <Thumbnail thumb={thumb} />}
    </Tag>
  );
}

function Thumbnail({
  thumb,
}: {
  thumb: { src: string; placeholder: string | null };
}) {
  const [loaded, setLoaded] = useState(false);
  return (
    <div style={thumbBaseStyle}>
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
  padding: '12px 0',
  border: 'none',
  width: '100%',
  textAlign: 'left',
  font: 'inherit',
  color: 'inherit',
  background: 'transparent',
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

// Same canonical border + neutral fill as every other thumb in the
// system. No brand-color background — neutral until the image loads,
// then the image covers it. When there's no image we render nothing
// at all (per Instapaper's own card chrome) so this style is only
// applied when a thumb is present.
const thumbBaseStyle: CSSProperties = {
  width: 80,
  height: 80,
  flexShrink: 0,
  borderRadius: 8,
  overflow: 'hidden',
  position: 'relative',
  background: 'rgba(127,127,127,0.06)',
  border: '1px solid var(--color-border-tertiary, rgba(127,127,127,0.12))',
  boxSizing: 'border-box',
};
