import type { CSSProperties } from 'react';
import { ArticleCard, type Article } from './ArticleCard.js';

export function ArticleList({
  items,
  onOpen,
}: {
  items: Article[];
  onOpen?: (url: string) => void;
}) {
  if (!items.length) {
    return (
      <div style={emptyStyle}>No recent reads in the selected window.</div>
    );
  }

  return (
    <div style={listStyle}>
      {items.map((a) => (
        <ArticleCard
          key={`${a.id}-${a.saved_at}`}
          article={a}
          onOpen={onOpen}
        />
      ))}
    </div>
  );
}

const listStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  width: '100%',
};

const emptyStyle: CSSProperties = {
  padding: 24,
  textAlign: 'center',
  opacity: 0.6,
  fontSize: 14,
};
