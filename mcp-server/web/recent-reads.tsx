import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useApp, useHostStyles } from '@modelcontextprotocol/ext-apps/react';
import { ArticleList } from './components/ArticleList.js';
import type { Article } from './components/ArticleCard.js';
import { rootStyle } from './lib/root-style.js';
import { stateStyle } from './lib/state-style.js';

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
  if (!isConnected) return null;
  if (items === null) return null;

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

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RecentReadsApp />
  </StrictMode>
);
