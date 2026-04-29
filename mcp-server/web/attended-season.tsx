import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useApp, useHostStyles } from '@modelcontextprotocol/ext-apps/react';
import { SeasonGrid, type SeasonPayload } from './components/SeasonGrid.js';
import { rootStyle } from './lib/root-style.js';
import { stateStyle } from './lib/state-style.js';

function AttendedSeasonApp() {
  const { app, isConnected, error } = useApp({
    appInfo: { name: 'rewind-attended-season', version: '0.1.0' },
    capabilities: {},
  });

  useHostStyles(app);

  const [payload, setPayload] = useState<SeasonPayload | null>(null);

  useEffect(() => {
    if (!app) return;
    app.ontoolresult = (result) => {
      const structured = result?.structuredContent as SeasonPayload | undefined;
      if (structured?.data) setPayload(structured);
    };
  }, [app]);

  if (error) return <div style={stateStyle}>Error: {error.message}</div>;
  if (!isConnected) return null;
  if (payload === null) return null;

  return (
    <div style={rootStyle}>
      <SeasonGrid payload={payload} />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AttendedSeasonApp />
  </StrictMode>
);
