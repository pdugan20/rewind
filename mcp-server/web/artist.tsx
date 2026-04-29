import { StrictMode, useEffect, useState, type CSSProperties } from 'react';
import { createRoot } from 'react-dom/client';
import { useApp, useHostStyles } from '@modelcontextprotocol/ext-apps/react';
import { ArtistDetail, type ArtistPayload } from './components/ArtistDetail.js';
import { rootStyle } from './lib/root-style.js';
import { stateStyle } from './lib/state-style.js';

function ArtistApp() {
  const { app, isConnected, error } = useApp({
    appInfo: { name: 'rewind-artist', version: '0.1.0' },
    capabilities: {},
  });

  useHostStyles(app);

  const [payload, setPayload] = useState<ArtistPayload | null>(null);

  useEffect(() => {
    if (!app) return;
    app.ontoolresult = (result) => {
      const structured = result?.structuredContent as ArtistPayload | undefined;
      if (structured?.artist?.id) setPayload(structured);
    };
  }, [app]);

  if (error) return <div style={stateStyle}>Error: {error.message}</div>;
  if (!isConnected) return null;
  if (payload === null) return null;

  return (
    <div style={rootStyle}>
      <ArtistDetail
        payload={payload}
        onOpen={(url) => {
          app?.openLink({ url });
        }}
      />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ArtistApp />
  </StrictMode>
);
