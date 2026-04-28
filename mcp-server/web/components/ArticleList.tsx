import type { CSSProperties } from 'react';
import { ArticleCard, type Article } from './ArticleCard.js';
import { cardOuterChrome } from '../lib/card-tokens.js';

export function ArticleList({
  items,
  onOpen,
}: {
  items: Article[];
  onOpen?: (url: string) => void;
}) {
  const subtitle =
    items.length === 1 ? '1 saved' : `${items.length.toLocaleString()} saved`;

  return (
    <article style={cardStyle}>
      <header style={headerStyle}>
        <h1 style={titleStyle}>Recent reads</h1>
        <div style={subtitleStyle}>{subtitle}</div>
      </header>
      {items.length === 0 ? (
        <div style={emptyStyle}>No recent reads in the selected window.</div>
      ) : (
        <div style={listStyle}>
          {items.map((a) => (
            <ArticleCard
              key={`${a.id}-${a.saved_at}`}
              article={a}
              onOpen={onOpen}
            />
          ))}
        </div>
      )}
    </article>
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

const listStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  width: '100%',
  // ArticleCard has `padding: '12px 0'`, which combined with the
  // card's gap left a noticeable air gap between the header and the
  // first article. Pull the list up so the first row sits closer to
  // the title without changing inter-row spacing.
  marginTop: -5,
};

const emptyStyle: CSSProperties = {
  padding: 24,
  textAlign: 'center',
  opacity: 0.6,
  fontSize: 14,
};
