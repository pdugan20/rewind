import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useApp, useHostStyles } from '@modelcontextprotocol/ext-apps/react';
import { ArtistGrid } from './components/ArtistGrid.js';
import type { TopItem } from './components/AlbumCard.js';

type TopArtistsPayload = {
  period: string;
  data: TopItem[];
};

function TopArtistsApp() {
  const { app, isConnected, error } = useApp({
    appInfo: { name: 'rewind-top-artists', version: '0.1.0' },
    capabilities: {},
  });

  useHostStyles(app);

  const [payload, setPayload] = useState<TopArtistsPayload | null>(null);

  useEffect(() => {
    if (!app) return;
    app.ontoolresult = (result) => {
      const structured = result?.structuredContent as
        | TopArtistsPayload
        | undefined;
      if (structured?.data) setPayload(structured);
    };
  }, [app]);

  if (error) {
    return <div style={stateStyle}>Error: {error.message}</div>;
  }
  if (!isConnected) {
    return <div style={stateStyle}>Connecting…</div>;
  }
  if (payload === null) {
    return <div style={stateStyle}>Waiting for artists…</div>;
  }

  // ArtistGrid renders its own header + period subtitle — no extra
  // wrapper header here.
  return (
    <div style={rootStyle}>
      <ArtistGrid
        items={payload.data}
        period={payload.period}
        onOpen={(url) => {
          app?.openLink({ url });
        }}
      />
    </div>
  );
}

const rootStyle: React.CSSProperties = {
  fontFamily: 'var(--font-sans, system-ui, -apple-system, sans-serif)',
  color: 'var(--color-text-primary, inherit)',
};

const stateStyle: React.CSSProperties = {
  fontFamily: 'var(--font-sans, system-ui, -apple-system, sans-serif)',
  padding: 24,
  textAlign: 'center',
  opacity: 0.6,
  fontSize: 14,
};

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <TopArtistsApp />
  </StrictMode>
);
