import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useApp, useHostStyles } from '@modelcontextprotocol/ext-apps/react';
import { ArticleList } from './components/ArticleList.js';
import type { Article } from './components/ArticleCard.js';

type RecentReadsPayload = {
  items: Article[];
};

function RecentReadsApp() {
  const { app, isConnected, error } = useApp({
    appInfo: { name: 'rewind-recent-reads', version: '0.1.0' },
    capabilities: {},
  });

  useHostStyles(app);

  const [items, setItems] = useState<Article[] | null>(null);

  useEffect(() => {
    if (!app) return;
    app.ontoolresult = (result) => {
      const structured = result?.structuredContent as
        | RecentReadsPayload
        | undefined;
      if (structured?.items) setItems(structured.items);
    };
  }, [app]);

  if (error) {
    return <div style={stateStyle}>Error: {error.message}</div>;
  }
  if (!isConnected) {
    return <div style={stateStyle}>Connecting…</div>;
  }
  if (items === null) {
    return <div style={stateStyle}>Waiting for articles…</div>;
  }

  return (
    <div style={rootStyle}>
      <ArticleList
        items={items}
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
    <RecentReadsApp />
  </StrictMode>
);
