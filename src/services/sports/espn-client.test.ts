import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ESPN_LEAGUES,
  ESPN_TEAM_IDS,
  getEspnGamesByDate,
} from './espn-client.js';

function mockResponse(events: unknown[]) {
  vi.mocked(globalThis.fetch).mockResolvedValueOnce(
    new Response(JSON.stringify({ events }), { status: 200 })
  );
}

describe('ESPN client', () => {
  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch');
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('parses NCAAF UW Huskies game (real shape from 2008-10-25)', async () => {
    mockResponse([
      {
        id: '282990264',
        date: '2008-10-26T00:00Z',
        season: { year: 2008 },
        status: { type: { description: 'Final' } },
        competitions: [
          {
            competitors: [
              {
                homeAway: 'home',
                score: '7',
                winner: false,
                team: { id: '264', displayName: 'Washington Huskies' },
              },
              {
                homeAway: 'away',
                score: '33',
                winner: true,
                team: { id: '87', displayName: 'Notre Dame Fighting Irish' },
              },
            ],
          },
        ],
      },
    ]);
    const result = await getEspnGamesByDate(
      ESPN_LEAGUES.ncaaf,
      '2008-10-25',
      ESPN_TEAM_IDS.uw_huskies
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      external_id: '282990264',
      external_source: 'espn',
      league: 'ncaaf',
      season: 2008,
      game_date: '2008-10-25',
      status: 'Final',
      home_team: { id: 264, name: 'Washington Huskies' },
      away_team: { id: 87, name: 'Notre Dame Fighting Irish' },
      home_score: 7,
      away_score: 33,
      home_is_winner: false,
      away_is_winner: true,
    });
  });

  it('YYYY-MM-DD → YYYYMMDD param conversion', async () => {
    mockResponse([]);
    await getEspnGamesByDate(
      ESPN_LEAGUES.nfl,
      '2024-09-15',
      ESPN_TEAM_IDS.seahawks
    );
    const url = vi.mocked(globalThis.fetch).mock.calls[0][0] as string;
    expect(url).toContain('dates=20240915');
    expect(url).toContain('football/nfl');
  });

  it('filters to games involving teamId, drops others', async () => {
    mockResponse([
      // Game 1: doesn't involve UW
      {
        id: 'A',
        date: '2024-01-01T00:00Z',
        season: { year: 2024 },
        competitions: [
          {
            competitors: [
              { homeAway: 'home', team: { id: '99' } },
              { homeAway: 'away', team: { id: '100' } },
            ],
          },
        ],
      },
      // Game 2: UW home
      {
        id: 'B',
        date: '2024-01-01T00:00Z',
        season: { year: 2024 },
        competitions: [
          {
            competitors: [
              {
                homeAway: 'home',
                score: '21',
                winner: true,
                team: { id: '264', displayName: 'UW' },
              },
              {
                homeAway: 'away',
                score: '14',
                winner: false,
                team: { id: '7', displayName: 'Other' },
              },
            ],
          },
        ],
      },
    ]);
    const result = await getEspnGamesByDate(
      ESPN_LEAGUES.ncaaf,
      '2024-01-01',
      ESPN_TEAM_IDS.uw_huskies
    );
    expect(result).toHaveLength(1);
    expect(result[0].external_id).toBe('B');
  });

  it('handles all six league discriminants', async () => {
    for (const league of [
      ESPN_LEAGUES.nfl,
      ESPN_LEAGUES.ncaaf,
      ESPN_LEAGUES.nba,
      ESPN_LEAGUES.wnba,
      ESPN_LEAGUES.ncaab,
      ESPN_LEAGUES.mls,
    ]) {
      mockResponse([]);
      await getEspnGamesByDate(league, '2024-06-15', 1);
      const url = vi.mocked(globalThis.fetch).mock.calls.at(-1)?.[0] as string;
      expect(url).toContain(`/${league.sport}/${league.league}/`);
    }
  });

  it('returns empty for no events', async () => {
    mockResponse([]);
    const result = await getEspnGamesByDate(
      ESPN_LEAGUES.nfl,
      '2024-07-04',
      ESPN_TEAM_IDS.seahawks
    );
    expect(result).toEqual([]);
  });

  it('handles missing scores (scheduled)', async () => {
    mockResponse([
      {
        id: 'sched',
        date: '2026-09-15T00:00Z',
        season: { year: 2026 },
        status: { type: { description: 'Scheduled' } },
        competitions: [
          {
            competitors: [
              { homeAway: 'home', team: { id: '264' } },
              { homeAway: 'away', team: { id: '7' } },
            ],
          },
        ],
      },
    ]);
    const result = await getEspnGamesByDate(
      ESPN_LEAGUES.ncaaf,
      '2026-09-14',
      ESPN_TEAM_IDS.uw_huskies
    );
    expect(result[0].home_score).toBeNull();
    expect(result[0].home_is_winner).toBeNull();
    expect(result[0].status).toBe('Scheduled');
  });

  it('throws on non-200', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      new Response('gone', { status: 410 })
    );
    await expect(
      getEspnGamesByDate(ESPN_LEAGUES.nfl, '2024-01-01', 1)
    ).rejects.toThrow(/410/);
  });
});
