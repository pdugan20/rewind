import { StrictMode, useEffect, useState, type CSSProperties } from 'react';
import { createRoot } from 'react-dom/client';
import { useApp, useHostStyles } from '@modelcontextprotocol/ext-apps/react';
import { GameCard, type EventDetail } from './components/GameCard.js';
import { rootStyle } from './lib/root-style.js';
import { stateStyle } from './lib/state-style.js';

function AttendedEventApp() {
  const { app, isConnected, error } = useApp({
    appInfo: { name: 'rewind-attended-event', version: '0.1.0' },
    capabilities: {},
  });

  useHostStyles(app);

  const [event, setEvent] = useState<EventDetail | null>(null);

  useEffect(() => {
    if (!app) return;
    app.ontoolresult = (result) => {
      const structured = result?.structuredContent as EventDetail | undefined;
      // get_attended_event returns the event object directly as
      // structuredContent (no wrapping `data` field).
      if (structured?.id) setEvent(structured);
    };
  }, [app]);

  if (error) return <div style={stateStyle}>Error: {error.message}</div>;
  if (!isConnected) return null;
  if (event === null) return null;

  return (
    <div style={rootStyle}>
      <GameCard event={event} />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AttendedEventApp />
  </StrictMode>
);
