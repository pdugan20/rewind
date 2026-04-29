import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useApp, useHostStyles } from '@modelcontextprotocol/ext-apps/react';
import { AlbumGrid } from './components/AlbumGrid.js';
import type { TopItem } from './components/AlbumCard.js';
import { rootStyle } from './lib/root-style.js';
import { stateStyle } from './lib/state-style.js';

type TopAlbumsPayload = {
  period: string;
  data: TopItem[];
};

function TopAlbumsApp() {
  const { app, isConnected, error } = useApp({
    appInfo: { name: 'rewind-top-albums', version: '0.1.0' },
    capabilities: {},
  });

  // Apply host-provided CSS variables, fonts, and theme (light/dark).
  useHostStyles(app);

  const [payload, setPayload] = useState<TopAlbumsPayload | null>(null);

  useEffect(() => {
    if (!app) return;
    app.ontoolresult = (result) => {
      const structured = result?.structuredContent as
        | TopAlbumsPayload
        | undefined;
      if (structured?.data) setPayload(structured);
    };
  }, [app]);

  if (error) {
    return <div style={stateStyle}>Error: {error.message}</div>;
  }
  if (!isConnected) return null;
  if (payload === null) return null;

  // AlbumGrid renders its own header + period subtitle — no extra
  // wrapper header here. Wrapping div carries the host font stack so
  // the card content inherits Claude's typography.
  return (
    <div style={rootStyle}>
      <AlbumGrid
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
    <TopAlbumsApp />
  </StrictMode>
);
