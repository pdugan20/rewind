import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useApp, useHostStyles } from '@modelcontextprotocol/ext-apps/react';
import { ArtistGrid } from './components/ArtistGrid.js';
import type { TopItem } from './components/AlbumCard.js';
import { rootStyle } from './lib/root-style.js';
import { stateStyle } from './lib/state-style.js';

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
  if (!isConnected) return null;
  if (payload === null) return null;

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

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <TopArtistsApp />
  </StrictMode>
);
