import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useApp, useHostStyles } from '@modelcontextprotocol/ext-apps/react';
import { SeasonGrid, type SeasonPayload } from './components/SeasonGrid.js';

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
  if (!isConnected) return <div style={stateStyle}>Connecting…</div>;
  if (payload === null)
    return <div style={stateStyle}>Waiting for season…</div>;

  return (
    <div style={rootStyle}>
      <SeasonGrid payload={payload} />
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
    <AttendedSeasonApp />
  </StrictMode>
);
