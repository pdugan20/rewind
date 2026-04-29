import { StrictMode, useEffect, useState, type CSSProperties } from 'react';
import { createRoot } from 'react-dom/client';
import { useApp, useHostStyles } from '@modelcontextprotocol/ext-apps/react';
// Production entry uses the AthleteDetailA layout — same one the
// workbench registry previews. AthletePayload still ships from
// AthleteDetail.js where it was originally defined; AthleteDetailA
// re-uses the type unchanged.
import { AthleteDetailA } from './components/AthleteDetailA.js';
import type { AthletePayload } from './components/AthleteDetail.js';
import { rootStyle } from './lib/root-style.js';
import { stateStyle } from './lib/state-style.js';

function AthleteApp() {
  const { app, isConnected, error } = useApp({
    appInfo: { name: 'rewind-attended-player', version: '0.1.0' },
    capabilities: {},
  });

  useHostStyles(app);

  const [payload, setPayload] = useState<AthletePayload | null>(null);

  useEffect(() => {
    if (!app) return;
    app.ontoolresult = (result) => {
      const structured = result?.structuredContent as
        | AthletePayload
        | undefined;
      if (structured?.player?.id) setPayload(structured);
    };
  }, [app]);

  if (error) return <div style={stateStyle}>Error: {error.message}</div>;
  if (!isConnected) return null;
  if (payload === null) return null;

  return (
    <div style={rootStyle}>
      <AthleteDetailA
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
    <AthleteApp />
  </StrictMode>
);
