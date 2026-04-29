import { StrictMode, useEffect, useState, type CSSProperties } from 'react';
import { createRoot } from 'react-dom/client';
import { useApp, useHostStyles } from '@modelcontextprotocol/ext-apps/react';
import {
  ArticleDetail,
  type ArticlePayload,
} from './components/ArticleDetail.js';
import { rootStyle } from './lib/root-style.js';
import { stateStyle } from './lib/state-style.js';

function ArticleApp() {
  const { app, isConnected, error } = useApp({
    appInfo: { name: 'rewind-article', version: '0.1.0' },
    capabilities: {},
  });

  useHostStyles(app);

  const [payload, setPayload] = useState<ArticlePayload | null>(null);

  useEffect(() => {
    if (!app) return;
    app.ontoolresult = (result) => {
      const structured = result?.structuredContent as
        | ArticlePayload
        | undefined;
      if (structured?.article?.id) setPayload(structured);
    };
  }, [app]);

  if (error) return <div style={stateStyle}>Error: {error.message}</div>;
  // Transient loading states return null so the host's own shimmer
  // is the only thing the user sees during connect / waiting. See
  // also lib/state-style.ts.
  if (!isConnected) return null;
  if (payload === null) return null;

  return (
    <div style={rootStyle}>
      <ArticleDetail
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
    <ArticleApp />
  </StrictMode>
);
