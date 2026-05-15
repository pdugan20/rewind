/**
 * Output-schema conformance — attending domain (issue #105).
 *
 * For every attending tool: run it end-to-end through the SDK against a
 * fixture and assert it resolves. The SDK's validateToolOutput throws if
 * `structuredContent` does not match the declared `outputSchema`, so a
 * resolved call IS the conformance proof. Also asserts each tool
 * advertises a clean JSON Schema (top-level object, no $ref, no
 * `additionalProperties: false`).
 *
 * Structured after output-schema-listening.test.ts.
 */
import { describe, it, expect, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../server.js';
import { RewindClient } from '../client.js';

// --- Fixtures (minimal valid API responses) -------------------------------

const teamFixture = {
  id: 136,
  league: 'mlb',
  abbreviation: 'SEA',
  location: 'Seattle',
  name: 'Mariners',
  full_name: 'Seattle Mariners',
  primary_color: '#0C2C56',
  secondary_color: '#005C5C',
  tertiary_color: '#C4CED4',
  ui_tint_color: '#0C2C56',
  logo_url: 'https://cdn.test/sea.png',
  logo_dark_url: null,
  logo_light_url: null,
  conference: null,
  division: 'AL West',
};

const playerFixture = {
  id: 1,
  league: 'mlb',
  mlb_stats_id: 663728,
  espn_id: null,
  full_name: 'Cal Raleigh',
  primary_position: 'C',
  primary_number: '29',
  birth_date: '1996-11-26',
  birth_country: 'USA',
  bats: 'S',
  throws: 'R',
  primary_team: teamFixture,
  debut_date: '2021-07-11',
  photo_silo: null,
  photo_full: null,
};

const eventFixture = {
  id: 10,
  category: 'sports',
  event_type: 'mlb_game',
  event_date: '2024-07-04',
  event_datetime: '2024-07-04T19:10:00Z',
  title: 'Mariners vs Astros',
  subtitle: 'SEA 5, HOU 3',
  external_id: 'gm-123',
  external_source: 'mlb',
  event_data: { attendance: 44021 },
  notes: null,
  attended: true,
  venue: {
    id: 3,
    name: 'T-Mobile Park',
    city: 'Seattle',
    state: 'WA',
    country: 'USA',
    capacity: 47929,
  },
  tickets: [],
};

const appearanceFixture = {
  player: playerFixture,
  team: teamFixture,
  is_home: true,
  batting_line: { ab: 4, h: 2, hr: 1, rbi: 3 },
  pitching_line: null,
  fielding_line: null,
  decision: null,
  notable: true,
};

const eventDetailFixture = {
  ...eventFixture,
  players: [appearanceFixture],
};

// get_attended_player builds a transformed nested shape from this raw API
// response. Nested stat blocks are given realistic-enough objects (or null)
// so the transform produces conforming output.
const playerDetailFixture = {
  ...playerFixture,
  supported: true,
  birth_city: 'Cullowhee',
  birth_state_province: 'NC',
  height: '6\' 3"',
  weight: 235,
  college_name: 'Florida State',
  awards: [{ season: '2023', id: 'GG', name: 'Gold Glove' }],
  season_stats: {
    season: 2026,
    fetched_at: '2026-05-15T00:00:00Z',
    cache_hit: true,
    hitter: { avg: '.250', slg: '.480', hr: 12, rbi: 35, games_played: 40 },
    pitcher: null,
  },
  career: {
    group: 'hitting',
    seasons: [{ season: 2024, hr: 34, rbi: 100 }],
    fetched_at: '2026-05-15T00:00:00Z',
    cache_hit: true,
  },
  splits: {
    season: 2026,
    group: 'hitting',
    home: { avg: '.270' },
    away: { avg: '.230' },
    vs_left: { avg: '.300' },
    vs_right: { avg: '.220' },
    fetched_at: '2026-05-15T00:00:00Z',
    cache_hit: true,
  },
  attended_summary: {
    games_attended: 32,
    games_with_box_score: 30,
    wins: 18,
    losses: 14,
    hitter: { ab: 110, h: 30, hr: 8, rbi: 25 },
    pitcher: null,
  },
  season_attended_summary: {
    games_attended: 5,
    games_with_box_score: 5,
    wins: 3,
    losses: 2,
    hitter: { ab: 18, h: 6, hr: 2, rbi: 5, avg: '.333' },
    pitcher: null,
  },
  season_attended_summary_season: 2026,
  appearances: [
    {
      event_id: 10,
      event_date: '2024-07-04',
      title: 'Mariners vs Astros',
      team: teamFixture,
      is_home: true,
      batting_line: { ab: 4, h: 2, hr: 1, rbi: 3 },
      pitching_line: null,
      decision: null,
      notable: true,
    },
  ],
  appearance_count: 1,
};

const playerStatsFixture = {
  supported: true,
  hitter: true,
  league: 'mlb',
  scope: 'career',
  player: {
    id: 1,
    full_name: 'Cal Raleigh',
    primary_position: 'C',
    primary_team: teamFixture,
  },
  games: 32,
  games_with_box_score: 30,
  batting: {
    pa: 130,
    ab: 110,
    h: 30,
    hr: 8,
    rbi: 25,
    bb: 18,
    k: 35,
    sb: 1,
    avg: '.273',
    slg: '.480',
  },
};

const ROUTES: Record<string, unknown> = {
  '/attending/events': { data: [eventFixture], pagination: PAGINATION() },
  '/attending/players': { data: [playerFixture], pagination: PAGINATION() },
  '/attending/stats': {
    total_events: 50,
    attended_events: 42,
    by_category: [{ category: 'sports', count: 30 }],
    by_event_type: [{ event_type: 'mlb_game', count: 25 }],
    by_year: [{ year: '2024', count: 12 }],
  },
  '/attending/year/2024': {
    year: 2024,
    total_events: 12,
    total_spent_cents: 48000,
    by_category: [{ category: 'sports', count: 8 }],
    by_event_type: [{ event_type: 'mlb_game', count: 8 }],
    monthly: [{ month: '2024-07', count: 3 }],
    top_venues: [
      { venue_id: 3, name: 'T-Mobile Park', city: 'Seattle', count: 6 },
    ],
    top_performers: [{ performer_id: 9, name: 'Bruce Springsteen', count: 1 }],
    events: [
      {
        id: 10,
        event_date: '2024-07-04',
        event_type: 'mlb_game',
        title: 'Mariners vs Astros',
        subtitle: 'SEA 5, HOU 3',
        venue_name: 'T-Mobile Park',
      },
    ],
  },
};

function PAGINATION() {
  return { page: 1, limit: 20, total: 1, total_pages: 1 };
}

function resolveRoute(path: string): unknown {
  if (path.startsWith('/attending/seasons/'))
    return {
      league: 'mlb',
      season: 2024,
      attended_count: 1,
      wins: 1,
      losses: 0,
      data: [eventFixture],
    };
  if (/^\/attending\/players\/\d+\/stats$/.test(path))
    return playerStatsFixture;
  if (/^\/attending\/players\/\d+$/.test(path)) return playerDetailFixture;
  if (/^\/attending\/events\/\d+$/.test(path)) return eventDetailFixture;
  return ROUTES[path] ?? {};
}

async function buildClient(): Promise<Client> {
  const rewindClient = new RewindClient('https://api.test', 'rw_test');
  vi.spyOn(rewindClient, 'get').mockImplementation(async (path: string) =>
    resolveRoute(path)
  );
  const server = createServer(rewindClient);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'output-schema-test', version: '1.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

const CASES: Array<{ name: string; args: Record<string, unknown> }> = [
  { name: 'get_attended_events', args: {} },
  { name: 'get_attended_season', args: { league: 'mlb', season: 2024 } },
  { name: 'get_attended_players', args: {} },
  { name: 'get_attended_player', args: { id: 1, include_images: false } },
  { name: 'get_attended_player_stats', args: { id: 1 } },
  { name: 'get_attending_stats', args: {} },
  { name: 'get_attended_event', args: { id: 10 } },
  { name: 'get_attending_year_in_review', args: { year: 2024 } },
];

describe('output-schema conformance — attending', () => {
  for (const c of CASES) {
    it(`${c.name}: structuredContent conforms to outputSchema`, async () => {
      const client = await buildClient();
      // A schema mismatch makes the SDK's validateToolOutput throw and this
      // call reject -- resolving without error IS the conformance check.
      const res = await client.callTool({ name: c.name, arguments: c.args });
      expect(res.isError).toBeFalsy();
      expect(res.structuredContent).toBeDefined();
    });
  }

  it('empty-state branches still conform', async () => {
    const rewindClient = new RewindClient('https://api.test', 'rw_test');
    vi.spyOn(rewindClient, 'get').mockImplementation(async (path: string) => {
      if (path === '/attending/events')
        return { data: [], pagination: PAGINATION() };
      if (path === '/attending/players')
        return { data: [], pagination: PAGINATION() };
      if (path.startsWith('/attending/seasons/'))
        return {
          league: 'mlb',
          season: 2024,
          attended_count: 0,
          wins: 0,
          losses: 0,
          data: [],
        };
      return {};
    });
    const server = createServer(rewindClient);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'empty-test', version: '1.0.0' });
    await server.connect(st);
    await client.connect(ct);

    for (const [name, args] of [
      ['get_attended_events', {}],
      ['get_attended_players', {}],
      ['get_attended_season', { league: 'mlb', season: 2024 }],
    ] as const) {
      const res = await client.callTool({ name, arguments: args });
      expect(res.isError, name).toBeFalsy();
    }
  });

  it('get_attended_player_stats unsupported branch conforms', async () => {
    const rewindClient = new RewindClient('https://api.test', 'rw_test');
    vi.spyOn(rewindClient, 'get').mockImplementation(async () => ({
      supported: false,
      league: 'nfl',
      reason: 'Per-player stat-line parsing not yet supported.',
      scope: 'career',
      player: {
        id: 2,
        full_name: 'Some Player',
        primary_position: 'QB',
        primary_team: null,
      },
      appearances: [
        {
          event_id: 99,
          event_date: '2024-09-08',
          title: 'Seahawks vs 49ers',
          home_team: 'Seahawks',
          away_team: '49ers',
          final_score: '24-17',
          my_team_won: true,
        },
      ],
    }));
    const server = createServer(rewindClient);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'unsupported-test', version: '1.0.0' });
    await server.connect(st);
    await client.connect(ct);

    const res = await client.callTool({
      name: 'get_attended_player_stats',
      arguments: { id: 2 },
    });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toBeDefined();
  });

  it('every attending tool advertises a clean outputSchema', async () => {
    const client = await buildClient();
    const { tools } = await client.listTools();
    const names = new Set(CASES.map((c) => c.name));
    const attending = tools.filter((t) => names.has(t.name));
    expect(attending).toHaveLength(CASES.length);

    for (const t of attending) {
      expect(t.outputSchema, t.name).toMatchObject({ type: 'object' });
      const json = JSON.stringify(t.outputSchema);
      // No $ref/$defs: older Claude Desktop builds failed to compile them.
      expect(json, `${t.name} $ref`).not.toContain('$ref');
      // .passthrough() keeps the advertised schema forward-compatible.
      expect(json, `${t.name} additionalProperties`).not.toContain(
        '"additionalProperties":false'
      );
    }
  });
});
