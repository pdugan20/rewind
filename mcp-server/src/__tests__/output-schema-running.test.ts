/**
 * Output-schema conformance — running domain (issue #105).
 *
 * For every running tool: run it end-to-end through the SDK against a
 * fixture and assert it resolves. The SDK's validateToolOutput throws if
 * `structuredContent` does not match the declared `outputSchema`, so a
 * resolved call IS the conformance proof. Also asserts each tool
 * advertises a clean JSON Schema (top-level object, no $ref, no
 * `additionalProperties: false`).
 *
 * Structure copied from output-schema-listening.test.ts.
 */
import { describe, it, expect, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../server.js';
import { RewindClient } from '../client.js';

// --- Fixtures (minimal valid API responses) -------------------------------

const activityFixture = {
  id: 1,
  strava_id: 1001,
  name: 'Morning Run',
  date: '2026-05-15T08:00:00Z',
  distance_mi: 5.2,
  duration: '42:10',
  pace: '8:06',
  elevation_ft: 120,
  city: 'Brooklyn',
  state: 'NY',
  is_race: false,
  strava_url: 'https://strava.com/activities/1001',
};

const prFixture = {
  distance_label: '5K',
  time: '21:30',
  pace: '6:55',
  date: '2026-04-01T08:00:00Z',
  activity_name: 'Spring 5K',
  activity_id: 2,
};

const splitFixture = {
  split: 1,
  distance_mi: 1.0,
  moving_time_s: 480,
  elapsed_time_s: 485,
  elevation_ft: 25,
  pace: '8:00',
  heartrate: 152,
};

const activityDetailFixture = {
  id: 1,
  name: 'Morning Run',
  date: '2026-05-15T08:00:00Z',
  distance_mi: 5.2,
  duration: '42:10',
  pace: '8:06',
  elevation_ft: 120,
  heartrate_avg: 150,
  heartrate_max: 172,
  cadence: 168,
  calories: 540,
  suffer_score: 45,
  city: 'Brooklyn',
  state: 'NY',
  is_race: false,
  workout_type: 'Run',
  strava_url: 'https://strava.com/activities/1001',
};

const yearFixture = {
  year: 2025,
  total_runs: 180,
  total_distance_mi: 920.5,
  total_elevation_ft: 18000,
  total_duration_s: 432000,
  avg_pace: '8:12',
  longest_run_mi: 26.2,
  race_count: 4,
};

const ROUTES: Record<string, unknown> = {
  '/running/stats': {
    data: {
      total_runs: 500,
      total_distance_mi: 2500.5,
      total_elevation_ft: 50000,
      total_duration: '300:00:00',
      avg_pace: '8:10',
      years_active: 5,
      first_run: '2021-01-01T08:00:00Z',
      eddington_number: 30,
    },
  },
  '/running/recent': { data: [activityFixture] },
  '/running/prs': { data: [prFixture] },
  '/running/streaks': {
    data: {
      current: { days: 5, start: '2026-05-10', end: '2026-05-15' },
      longest: { days: 30, start: '2025-01-01', end: '2025-01-31' },
    },
  },
  '/running/stats/years': { data: [yearFixture] },
};

function resolveRoute(path: string): unknown {
  if (/^\/running\/activities\/\d+\/splits$/.test(path)) {
    return { data: [splitFixture] };
  }
  if (/^\/running\/activities\/\d+$/.test(path)) {
    return activityDetailFixture;
  }
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
  { name: 'get_running_stats', args: {} },
  { name: 'get_recent_runs', args: {} },
  { name: 'get_personal_records', args: {} },
  { name: 'get_running_streaks', args: {} },
  { name: 'get_activity_details', args: { id: 1 } },
  { name: 'get_activity_splits', args: { id: 1 } },
  { name: 'get_running_years', args: {} },
];

describe('output-schema conformance — running', () => {
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
      if (path === '/running/recent') return { data: [] };
      if (path === '/running/prs') return { data: [] };
      if (path === '/running/stats/years') return { data: [] };
      if (/^\/running\/activities\/\d+\/splits$/.test(path))
        return { data: [] };
      return {};
    });
    const server = createServer(rewindClient);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'empty-test', version: '1.0.0' });
    await server.connect(st);
    await client.connect(ct);

    for (const [name, args] of [
      ['get_recent_runs', {}],
      ['get_personal_records', {}],
      ['get_activity_splits', { id: 1 }],
      ['get_running_years', {}],
    ] as const) {
      const res = await client.callTool({ name, arguments: args });
      expect(res.isError, name).toBeFalsy();
    }
  });

  it('every running tool advertises a clean outputSchema', async () => {
    const client = await buildClient();
    const { tools } = await client.listTools();
    const names = new Set(CASES.map((c) => c.name));
    const running = tools.filter((t) => names.has(t.name));
    expect(running).toHaveLength(CASES.length);

    for (const t of running) {
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
