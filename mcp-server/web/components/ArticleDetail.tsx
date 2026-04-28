import { useState, type CSSProperties } from 'react';
import { thumbhashToDataUrl } from '../lib/thumbhash.js';
import { timeAgo } from '../lib/time-ago.js';
import { cardOuterChrome } from '../lib/card-tokens.js';

type Image = {
  cdn_url?: string | null;
  url?: string | null;
  thumbhash?: string | null;
  dominant_color?: string | null;
  accent_color?: string | null;
} | null;

export type ArticleMeta = {
  id: number;
  title: string;
  author: string | null;
  url: string | null;
  instapaper_url: string | null;
  instapaper_app_url: string | null;
  domain: string | null;
  description: string | null;
  word_count: number | null;
  estimated_read_min: number | null;
  status: string;
  progress: number;
  saved_at: string;
  image: Image;
};

export type Highlight = {
  id: number;
  text: string;
  note: string | null;
  created_at: string;
};

export type ArticlePayload = {
  article: ArticleMeta;
  highlights: Highlight[];
  highlight_count: number;
};

const HERO_W = 720;
const HERO_H = 405; // 16:9
const CDN_TRANSFORM = `width=${HERO_W * 2},height=${HERO_H * 2},fit=cover,format=auto,quality=85`;

function buildHeroSrc(
  image: Image
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

export function ArticleDetail({
  payload,
  onOpen,
}: {
  payload: ArticlePayload;
  onOpen?: (url: string) => void;
}) {
  const { article, highlights, highlight_count } = payload;
  const hero = buildHeroSrc(article.image);
  const accent = article.image?.accent_color ?? 'var(--color-accent, #4c6ef5)';
  const dominant =
    article.image?.dominant_color ?? 'var(--color-surface, #2a2a2a)';

  // Single-line lockup: domain · author · N min · X ago.
  // Mirrors the Instapaper card chrome (`nytimes.com · Kate Conger · 2 min`)
  // with the saved-time tagged on so the user keeps a sense of "when".
  const meta = [
    article.domain,
    article.author,
    article.estimated_read_min ? `${article.estimated_read_min} min` : null,
    timeAgo(article.saved_at),
  ].filter(Boolean) as string[];

  const showProgress =
    article.progress > 0 &&
    article.progress < 1 &&
    article.status === 'reading';
  const visibleHighlights = highlights.slice(0, 3);
  const remainingHighlights = highlight_count - visibleHighlights.length;

  return (
    <article style={cardStyle}>
      <Hero
        hero={hero}
        accent={accent}
        dominant={dominant}
        title={article.title}
      />

      <div style={bodyStyle}>
        <h1 style={titleStyle}>{article.title}</h1>
        <div style={metaLineStyle}>{meta.join(' · ')}</div>

        {showProgress && (
          <ProgressBar progress={article.progress} accent={accent} />
        )}

        {article.description && (
          <p style={descriptionStyle}>{article.description}</p>
        )}

        {visibleHighlights.length > 0 && (
          <HighlightsPanel
            highlights={visibleHighlights}
            remaining={remainingHighlights}
          />
        )}

        {article.url && (
          <Footer
            sourceUrl={article.url}
            domain={article.domain}
            onOpen={onOpen}
          />
        )}
      </div>
    </article>
  );
}

function Hero({
  hero,
  accent,
  dominant,
  title,
}: {
  hero: { src: string; placeholder: string | null } | null;
  accent: string;
  dominant: string;
  title: string;
}) {
  const [loaded, setLoaded] = useState(false);

  if (!hero) {
    return (
      <div
        style={{
          ...heroBaseStyle,
          background: `linear-gradient(135deg, ${dominant} 0%, ${accent} 100%)`,
          display: 'flex',
          alignItems: 'flex-end',
          padding: 24,
        }}
        aria-hidden
      >
        <span style={heroFallbackTextStyle}>{title.slice(0, 1)}</span>
      </div>
    );
  }

  return (
    <div
      style={{
        ...heroBaseStyle,
        background: dominant,
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      {hero.placeholder && (
        <img
          src={hero.placeholder}
          alt=""
          aria-hidden
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            filter: 'blur(16px)',
            transform: 'scale(1.05)',
            opacity: loaded ? 0 : 1,
            transition: 'opacity 200ms ease',
          }}
        />
      )}
      <img
        src={hero.src}
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
          transition: 'opacity 240ms ease',
        }}
      />
    </div>
  );
}

function ProgressBar({
  progress,
  accent,
}: {
  progress: number;
  accent: string;
}) {
  const pct = Math.round(progress * 100);
  return (
    <div
      role="progressbar"
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={`${pct}% read`}
      style={progressTrackStyle}
    >
      <div
        style={{
          ...progressFillStyle,
          width: `${pct}%`,
          background: accent,
        }}
      />
    </div>
  );
}

function HighlightsPanel({
  highlights,
  remaining,
}: {
  highlights: Highlight[];
  remaining: number;
}) {
  return (
    <section style={highlightsSectionStyle}>
      <h2 style={highlightsHeadingStyle}>
        Your highlights
        <span style={highlightsCountStyle}>
          {highlights.length + Math.max(0, remaining)}
        </span>
      </h2>
      <div style={highlightsListStyle}>
        {highlights.map((h) => (
          <div key={h.id} style={highlightRowStyle}>
            <div style={highlightTextStyle}>{h.text}</div>
            {h.note && <div style={highlightNoteStyle}>{h.note}</div>}
          </div>
        ))}
      </div>
      {remaining > 0 && (
        <div style={highlightsMoreStyle}>
          + {remaining} more highlight{remaining === 1 ? '' : 's'}
        </div>
      )}
    </section>
  );
}

function Footer({
  sourceUrl,
  domain,
  onOpen,
}: {
  sourceUrl: string;
  domain: string | null;
  onOpen?: (u: string) => void;
}) {
  // Black pill matching the artist card's "Listen on Apple Music" CTA
  // and the TopTracks "Listen ↗" treatment so all single-entity CTAs
  // share one idiom.
  return (
    <div style={footerStyle}>
      <button
        type="button"
        onClick={() => onOpen?.(sourceUrl)}
        style={readButtonStyle}
      >
        Read on {domain ?? 'source'} ↗
      </button>
    </div>
  );
}

const cardStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  maxWidth: 720,
  margin: '0 auto',
  borderRadius: 12,
  overflow: 'hidden',
  ...cardOuterChrome,
};

const heroBaseStyle: CSSProperties = {
  width: '100%',
  aspectRatio: '16 / 9',
  flexShrink: 0,
};

const heroFallbackTextStyle: CSSProperties = {
  fontSize: 64,
  fontWeight: 700,
  color: 'rgba(255,255,255,0.85)',
  textShadow: '0 2px 8px rgba(0,0,0,0.25)',
  letterSpacing: -2,
};

const bodyStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  padding: '20px 22px 22px',
};

const titleStyle: CSSProperties = {
  fontSize: 22,
  lineHeight: 1.25,
  fontWeight: 700,
  margin: 0,
  display: '-webkit-box',
  WebkitBoxOrient: 'vertical',
  WebkitLineClamp: 2,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  color: 'var(--color-text-primary, inherit)',
};

// Single dim line under the title — domain · author · read time · saved.
// Negative top offset against the bodyStyle gap so the line tucks
// closer to the title (reads as the title's subline rather than its
// own band of metadata).
const metaLineStyle: CSSProperties = {
  fontSize: 13,
  opacity: 0.7,
  color: 'var(--color-text-secondary, inherit)',
  marginTop: -3,
};

const progressTrackStyle: CSSProperties = {
  height: 3,
  background: 'rgba(127,127,127,0.18)',
  borderRadius: 2,
  overflow: 'hidden',
};

const progressFillStyle: CSSProperties = {
  height: '100%',
  borderRadius: 2,
  transition: 'width 240ms ease',
};

const descriptionStyle: CSSProperties = {
  fontSize: 15,
  lineHeight: 1.5,
  margin: '4px 0 0',
  opacity: 0.85,
  color: 'var(--color-text-primary, inherit)',
  display: '-webkit-box',
  WebkitBoxOrient: 'vertical',
  WebkitLineClamp: 3,
  overflow: 'hidden',
};

const highlightsSectionStyle: CSSProperties = {
  marginTop: 4,
  paddingTop: 14,
  borderTop: '1px solid var(--color-border-tertiary, rgba(127,127,127,0.12))',
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
};

const highlightsHeadingStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  letterSpacing: 0.6,
  textTransform: 'uppercase',
  margin: 0,
  opacity: 0.65,
  display: 'flex',
  alignItems: 'center',
  gap: 8,
};

const highlightsCountStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 500,
  background: 'rgba(127,127,127,0.15)',
  color: 'inherit',
  padding: '2px 7px',
  borderRadius: 999,
  letterSpacing: 0,
};

const highlightsListStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
};

const highlightRowStyle: CSSProperties = {
  borderLeft: '3px solid var(--color-accent, #4c6ef5)',
  paddingLeft: 12,
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
};

const highlightTextStyle: CSSProperties = {
  fontSize: 14,
  lineHeight: 1.45,
  fontStyle: 'italic',
  color: 'var(--color-text-primary, inherit)',
};

const highlightNoteStyle: CSSProperties = {
  fontSize: 13,
  lineHeight: 1.4,
  opacity: 0.7,
  color: 'var(--color-text-secondary, inherit)',
};

const highlightsMoreStyle: CSSProperties = {
  fontSize: 12,
  opacity: 0.55,
  fontStyle: 'italic',
};

const footerStyle: CSSProperties = {
  display: 'flex',
  marginTop: 4,
};

const readButtonStyle: CSSProperties = {
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
