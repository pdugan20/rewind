import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useApp, useHostStyles } from '@modelcontextprotocol/ext-apps/react';
import { PosterGrid } from './components/PosterGrid.js';
import type { Watch } from './components/PosterCard.js';
import { rootStyle } from './lib/root-style.js';
import { stateStyle } from './lib/state-style.js';

type RecentWatchesPayload = {
  items: Watch[];
};

function RecentWatchesApp() {
  const { app, isConnected, error } = useApp({
    appInfo: { name: 'rewind-recent-watches', version: '0.1.0' },
    capabilities: {},
  });

  // Apply host-provided CSS variables, fonts, and theme (light/dark).
  // The iframe inherits Claude Desktop / web's typography and color scheme.
  useHostStyles(app);

  const [items, setItems] = useState<Watch[] | null>(null);

  useEffect(() => {
    if (!app) return;
    app.ontoolresult = (result) => {
      const structured = result?.structuredContent as
        | RecentWatchesPayload
        | undefined;
      if (structured?.items) setItems(structured.items);
    };
  }, [app]);

  if (error) {
    return <div style={stateStyle}>Error: {error.message}</div>;
  }
  if (!isConnected) return null;
  if (items === null) return null;

  return (
    <div style={rootStyle}>
      <PosterGrid
        items={items}
        onOpen={(url) => {
          app?.openLink({ url });
        }}
      />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RecentWatchesApp />
  </StrictMode>
);
