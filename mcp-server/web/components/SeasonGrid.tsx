import type { CSSProperties } from 'react';
import {
  SeasonGameCard,
  type Game,
  type GamePlayer,
} from './SeasonGameCard.js';

export type SeasonPayload = {
  league: string;
  season: number;
  attended_count: number;
  wins: number;
  losses: number;
  data: Game[];
};

export function SeasonGrid({ payload }: { payload: SeasonPayload }) {
  if (!payload.data.length) {
    return (
      <div style={emptyStyle}>
        No attended {payload.league.toUpperCase()} games in {payload.season}.
      </div>
    );
  }

  // Sort chronologically (event_date asc) — season grids read better
  // forward-in-time. The list endpoint returns asc already; this is
  // a guard for callers who pass pre-sorted data.
  const sorted = [...payload.data].sort((a, b) =>
    a.event_date.localeCompare(b.event_date)
  );

  return (
    <div style={rootStyle}>
      <header style={headerStyle}>
        <div style={titleStyle}>
          {payload.league.toUpperCase()} {payload.season}
        </div>
        <div style={subStyle}>
          {payload.attended_count} games attended ·{' '}
          <strong style={{ color: '#16a34a' }}>{payload.wins}W</strong>{' '}
          <strong style={{ color: '#dc2626' }}>{payload.losses}L</strong>
        </div>
      </header>
      <div style={gridStyle}>
        {sorted.map((g) => {
          const notable = filterNotable(g.players);
          return (
            <SeasonGameCard key={g.id} game={g} notablePlayers={notable} />
          );
        })}
      </div>
    </div>
  );
}

function filterNotable(players: GamePlayer[] | undefined): GamePlayer[] {
  if (!players) return [];
  return players
    .filter((p) => p.notable)
    .sort((a, b) => {
      // Decisions first (W/L/SV), then everyone else.
      const ra = a.decision ? 0 : 1;
      const rb = b.decision ? 0 : 1;
      return ra - rb;
    });
}

const rootStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  padding: 12,
};

const headerStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  paddingLeft: 4,
};

const titleStyle: CSSProperties = {
  fontSize: 18,
  fontWeight: 700,
};

const subStyle: CSSProperties = {
  fontSize: 13,
  opacity: 0.7,
};

const gridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns:
    'repeat(auto-fill, minmax(clamp(220px, 28vw, 280px), 1fr))',
  gap: 12,
};

const emptyStyle: CSSProperties = {
  padding: 24,
  textAlign: 'center',
  opacity: 0.6,
  fontSize: 14,
};
