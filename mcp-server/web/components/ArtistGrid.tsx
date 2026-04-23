import type { CSSProperties } from 'react';
import { ArtistCard } from './ArtistCard.js';
import type { TopItem } from './AlbumCard.js';

export function ArtistGrid({
  items,
  onOpen,
}: {
  items: TopItem[];
  onOpen?: (url: string) => void;
}) {
  if (!items.length) {
    return <div style={emptyStyle}>No top artists in this window.</div>;
  }

  return (
    <div style={gridStyle}>
      {items.map((item) => (
        <ArtistCard
          key={`${item.id}-${item.rank}`}
          item={item}
          onOpen={onOpen}
        />
      ))}
    </div>
  );
}

const gridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns:
    'repeat(auto-fill, minmax(clamp(120px, 18vw, 160px), 1fr))',
  gap: 8,
  padding: 12,
};

const emptyStyle: CSSProperties = {
  padding: 24,
  textAlign: 'center',
  opacity: 0.6,
  fontSize: 14,
};
