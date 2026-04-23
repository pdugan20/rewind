import type { CSSProperties } from 'react';
import { AlbumCard, type TopItem } from './AlbumCard.js';

export function AlbumGrid({
  items,
  onOpen,
}: {
  items: TopItem[];
  onOpen?: (url: string) => void;
}) {
  if (!items.length) {
    return <div style={emptyStyle}>No top albums in this window.</div>;
  }

  return (
    <div style={gridStyle}>
      {items.map((item) => (
        <AlbumCard
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
    'repeat(auto-fill, minmax(clamp(140px, 22vw, 200px), 1fr))',
  gap: 12,
  padding: 12,
};

const emptyStyle: CSSProperties = {
  padding: 24,
  textAlign: 'center',
  opacity: 0.6,
  fontSize: 14,
};
