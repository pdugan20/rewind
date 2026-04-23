import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useApp, useHostStyles } from '@modelcontextprotocol/ext-apps/react';
import { AlbumGrid } from './components/AlbumGrid.js';
import type { TopItem } from './components/AlbumCard.js';

type TopAlbumsPayload = {
  period: string;
  data: TopItem[];
};

function TopAlbumsApp() {
  const { app, isConnected, error } = useApp({
    appInfo: { name: 'rewind-top-albums', version: '0.1.0' },
    capabilities: {},
  });

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
  if (!isConnected) {
    return <div style={stateStyle}>Connecting…</div>;
  }
  if (payload === null) {
    return <div style={stateStyle}>Waiting for albums…</div>;
  }

  return (
    <div style={rootStyle}>
      <div style={headerStyle}>Top albums · {formatPeriod(payload.period)}</div>
      <AlbumGrid
        items={payload.data}
        onOpen={(url) => {
          app?.openLink({ url });
        }}
      />
    </div>
  );
}

function formatPeriod(period: string): string {
  switch (period) {
    case '7day':
      return 'last 7 days';
    case '1month':
      return 'last month';
    case '3month':
      return 'last 3 months';
    case '6month':
      return 'last 6 months';
    case '12month':
      return 'last 12 months';
    case 'overall':
      return 'all time';
    default:
      return period;
  }
}

const rootStyle: React.CSSProperties = {
  fontFamily: 'var(--font-sans, system-ui, -apple-system, sans-serif)',
  color: 'var(--color-text-primary, inherit)',
};

const headerStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  opacity: 0.7,
  padding: '12px 12px 0 12px',
  textTransform: 'uppercase',
  letterSpacing: 0.5,
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
    <TopAlbumsApp />
  </StrictMode>
);
