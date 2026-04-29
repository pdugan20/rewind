import { StrictMode, useEffect, useState, type CSSProperties } from 'react';
import { createRoot } from 'react-dom/client';
import { useApp, useHostStyles } from '@modelcontextprotocol/ext-apps/react';
import { TopTracks, type TopTracksPayload } from './components/TopTracks.js';
import { rootStyle } from './lib/root-style.js';
import { stateStyle } from './lib/state-style.js';

function TopTracksApp() {
  const { app, isConnected, error } = useApp({
    appInfo: { name: 'rewind-top-tracks', version: '0.1.0' },
    capabilities: {},
  });

  useHostStyles(app);

  const [payload, setPayload] = useState<TopTracksPayload | null>(null);

  useEffect(() => {
    if (!app) return;
    app.ontoolresult = (result) => {
      const structured = result?.structuredContent as
        | TopTracksPayload
        | undefined;
      if (structured?.data && Array.isArray(structured.data))
        setPayload(structured);
    };
  }, [app]);

  if (error) return <div style={stateStyle}>Error: {error.message}</div>;
  if (!isConnected) return null;
  if (payload === null) return null;

  return (
    <div style={rootStyle}>
      <TopTracks
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
    <TopTracksApp />
  </StrictMode>
);
