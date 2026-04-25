import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getMlbGamesByDate, MLB_TEAM_IDS } from './mlb-client.js';

describe('MLB Stats client', () => {
  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch');
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('parses a regular-season game (Mariners @ Astros 2024-09-25)', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          dates: [
            {
              date: '2024-09-25',
              games: [
                {
                  gamePk: 746331,
                  gameDate: '2024-09-25T18:10:00Z',
                  officialDate: '2024-09-25',
                  gameType: 'R',
                  season: '2024',
                  status: { detailedState: 'Final' },
                  teams: {
                    away: {
                      team: { id: 136, name: 'Seattle Mariners' },
                      score: 8,
                      isWinner: true,
                    },
                    home: {
                      team: { id: 117, name: 'Houston Astros' },
                      score: 1,
                      isWinner: false,
                    },
                  },
                },
              ],
            },
          ],
        }),
        { status: 200 }
      )
    );

    const result = await getMlbGamesByDate('2024-09-25', MLB_TEAM_IDS.mariners);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      external_id: '746331',
      external_source: 'mlb_stats_api',
      league: 'mlb',
      season: 2024,
      game_type: 'R',
      game_date: '2024-09-25',
      status: 'Final',
      home_team: { id: 117, name: 'Houston Astros' },
      away_team: { id: 136, name: 'Seattle Mariners' },
      home_score: 1,
      away_score: 8,
      home_is_winner: false,
      away_is_winner: true,
    });
  });

  it('handles doubleheaders (returns both games)', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          dates: [
            {
              date: '2024-08-15',
              games: [
                {
                  gamePk: 1,
                  gameDate: '2024-08-15T17:00:00Z',
                  officialDate: '2024-08-15',
                  gameType: 'R',
                  season: '2024',
                  status: { detailedState: 'Final' },
                  teams: {
                    home: {
                      team: { id: 136, name: 'Mariners' },
                      score: 4,
                      isWinner: true,
                    },
                    away: {
                      team: { id: 1, name: 'Other' },
                      score: 2,
                      isWinner: false,
                    },
                  },
                },
                {
                  gamePk: 2,
                  gameDate: '2024-08-15T22:30:00Z',
                  officialDate: '2024-08-15',
                  gameType: 'R',
                  season: '2024',
                  status: { detailedState: 'Final' },
                  teams: {
                    home: {
                      team: { id: 136, name: 'Mariners' },
                      score: 1,
                      isWinner: false,
                    },
                    away: {
                      team: { id: 1, name: 'Other' },
                      score: 5,
                      isWinner: true,
                    },
                  },
                },
              ],
            },
          ],
        }),
        { status: 200 }
      )
    );
    const result = await getMlbGamesByDate('2024-08-15', 136);
    expect(result).toHaveLength(2);
    expect(result.map((g) => g.external_id)).toEqual(['1', '2']);
  });

  it('returns empty when no games on date', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ dates: [] }), { status: 200 })
    );
    const result = await getMlbGamesByDate('2024-12-25', 136);
    expect(result).toEqual([]);
  });

  it('handles missing scores (scheduled but not played)', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          dates: [
            {
              date: '2026-09-25',
              games: [
                {
                  gamePk: 999,
                  gameDate: '2026-09-25T19:10:00Z',
                  officialDate: '2026-09-25',
                  gameType: 'R',
                  season: '2026',
                  status: { detailedState: 'Scheduled' },
                  teams: {
                    home: { team: { id: 136, name: 'Mariners' } },
                    away: { team: { id: 117, name: 'Astros' } },
                  },
                },
              ],
            },
          ],
        }),
        { status: 200 }
      )
    );
    const result = await getMlbGamesByDate('2026-09-25', 136);
    expect(result[0].home_score).toBeNull();
    expect(result[0].home_is_winner).toBeNull();
  });

  it('throws on non-200', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      new Response('server error', { status: 500 })
    );
    await expect(getMlbGamesByDate('2024-01-01', 136)).rejects.toThrow(/500/);
  });
});
