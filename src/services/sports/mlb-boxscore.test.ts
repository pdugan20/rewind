import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchMlbBoxScore } from './mlb-boxscore.js';

// Minimal fixtures patterned on real responses from
// https://statsapi.mlb.com/api/v1/game/745223/boxscore and
// https://statsapi.mlb.com/api/v1.1/game/745223/feed/live (Mariners
// vs Tigers, 2024-08-07).
const BOXSCORE_FIXTURE = {
  teams: {
    home: {
      team: { id: 136, name: 'Seattle Mariners' },
      pitchers: [669923, 669402], // Kirby starts
      battingOrder: [
        645302, 663656, 641933, 596142, 668939, 671277, 673357, 668800, 666144,
      ],
      players: {
        ID669923: {
          person: {
            id: 669923,
            fullName: 'George Kirby',
            firstName: 'George',
            lastName: 'Kirby',
            primaryNumber: '68',
            mlbDebutDate: '2022-05-08',
            batSide: { code: 'L' },
            pitchHand: { code: 'R' },
          },
          jerseyNumber: '68',
          position: { abbreviation: 'P' },
          stats: {
            pitching: {
              gamesPlayed: 1,
              inningsPitched: '7.0',
              hits: 4,
              runs: 1,
              earnedRuns: 1,
              baseOnBalls: 1,
              strikeOuts: 6,
              homeRuns: 1,
              numberOfPitches: 97,
              strikes: 65,
              battersFaced: 23,
              era: '3.45',
              summary: '7.0 IP, 4 H, 1 R, 1 ER, 1 BB, 6 K',
            },
          },
        },
        ID645302: {
          person: {
            id: 645302,
            fullName: 'Victor Robles',
            firstName: 'Victor',
            lastName: 'Robles',
            primaryNumber: '10',
            batSide: { code: 'R' },
            pitchHand: { code: 'R' },
          },
          jerseyNumber: '10',
          position: { abbreviation: 'CF' },
          battingOrder: '100',
          stats: {
            batting: {
              gamesPlayed: 1,
              atBats: 4,
              runs: 0,
              hits: 0,
              rbi: 0,
              baseOnBalls: 0,
              strikeOuts: 1,
              homeRuns: 0,
              doubles: 0,
              triples: 0,
              stolenBases: 0,
              hitByPitch: 0,
              plateAppearances: 4,
              totalBases: 0,
              leftOnBase: 0,
              summary: '0-4 | K',
            },
          },
        },
        ID596142: {
          person: {
            id: 596142,
            fullName: 'Cal Raleigh',
            firstName: 'Cal',
            lastName: 'Raleigh',
            primaryNumber: '29',
            batSide: { code: 'B' },
            pitchHand: { code: 'R' },
          },
          jerseyNumber: '29',
          position: { abbreviation: 'C' },
          battingOrder: '400',
          stats: {
            batting: {
              gamesPlayed: 1,
              atBats: 4,
              runs: 1,
              hits: 2,
              rbi: 1,
              baseOnBalls: 0,
              strikeOuts: 1,
              homeRuns: 1,
              doubles: 0,
              triples: 0,
              stolenBases: 0,
              hitByPitch: 0,
              plateAppearances: 4,
              totalBases: 5,
              leftOnBase: 1,
              summary: '2-4, HR, RBI',
            },
          },
        },
      },
    },
    away: {
      team: { id: 116, name: 'Detroit Tigers' },
      pitchers: [669373], // Skubal
      players: {
        ID669373: {
          person: {
            id: 669373,
            fullName: 'Tarik Skubal',
            firstName: 'Tarik',
            lastName: 'Skubal',
            primaryNumber: '29',
            batSide: { code: 'L' },
            pitchHand: { code: 'L' },
          },
          jerseyNumber: '29',
          position: { abbreviation: 'P' },
          stats: {
            pitching: {
              gamesPlayed: 1,
              inningsPitched: '8.0',
              hits: 3,
              runs: 1,
              earnedRuns: 1,
              baseOnBalls: 1,
              strikeOuts: 12,
              homeRuns: 1,
              numberOfPitches: 102,
              strikes: 70,
              battersFaced: 26,
              era: '2.45',
              summary: '8.0 IP, 3 H, 1 R, 1 ER, 12 K (W)',
            },
          },
        },
      },
    },
  },
};

const FEED_FIXTURE = {
  gamePk: 745223,
  gameData: {
    gameInfo: {
      attendance: 26033,
      firstPitch: '2024-08-08T01:42:00.000Z',
      gameDurationMinutes: 153,
    },
    weather: { condition: 'Clear', temp: '73', wind: '2 mph, In From LF' },
    venue: { name: 'T-Mobile Park' },
  },
  liveData: {
    linescore: {
      innings: [
        {
          num: 1,
          home: { runs: 0, hits: 0, errors: 0 },
          away: { runs: 0, hits: 0, errors: 0 },
        },
        {
          num: 2,
          home: { runs: 0, hits: 0, errors: 0 },
          away: { runs: 0, hits: 0, errors: 0 },
        },
        {
          num: 3,
          home: { runs: 0, hits: 1, errors: 0 },
          away: { runs: 1, hits: 1, errors: 0 },
        },
        {
          num: 4,
          home: { runs: 1, hits: 1, errors: 0 },
          away: { runs: 0, hits: 0, errors: 0 },
        },
        {
          num: 5,
          home: { runs: 0, hits: 0, errors: 0 },
          away: { runs: 0, hits: 0, errors: 0 },
        },
        {
          num: 6,
          home: { runs: 0, hits: 0, errors: 0 },
          away: { runs: 0, hits: 0, errors: 0 },
        },
        {
          num: 7,
          home: { runs: 0, hits: 0, errors: 0 },
          away: { runs: 0, hits: 0, errors: 0 },
        },
        {
          num: 8,
          home: { runs: 0, hits: 0, errors: 0 },
          away: { runs: 0, hits: 0, errors: 0 },
        },
        {
          num: 9,
          home: { runs: 0, hits: 0, errors: 0 },
          away: { runs: 0, hits: 0, errors: 0 },
        },
      ],
    },
    decisions: {
      winner: { id: 669373, fullName: 'Tarik Skubal' },
      loser: { id: 669923, fullName: 'George Kirby' },
    },
  },
};

describe('fetchMlbBoxScore', () => {
  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes('/boxscore')) {
        return new Response(JSON.stringify(BOXSCORE_FIXTURE), { status: 200 });
      }
      if (u.includes('/feed/live')) {
        return new Response(JSON.stringify(FEED_FIXTURE), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it('returns null when boxscore is 404', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('not found', { status: 404 })
    );
    expect(await fetchMlbBoxScore(123456)).toBeNull();
  });

  it('parses game-level fields from feed/live', async () => {
    const data = await fetchMlbBoxScore(745223);
    expect(data).not.toBeNull();
    expect(data!.attendance).toBe(26033);
    expect(data!.weather).toEqual({
      condition: 'Clear',
      temp: '73',
      wind: '2 mph, In From LF',
    });
    expect(data!.duration_minutes).toBe(153);
    expect(data!.venue_name).toBe('T-Mobile Park');
    expect(data!.linescore).toHaveLength(9);
    expect(data!.winning_pitcher_id).toBe(669373);
    expect(data!.losing_pitcher_id).toBe(669923);
    expect(data!.save_pitcher_id).toBeNull();
  });

  it('extracts starting pitchers from each side', async () => {
    const data = await fetchMlbBoxScore(745223);
    expect(data!.starting_pitcher_home_id).toBe(669923); // Kirby
    expect(data!.starting_pitcher_away_id).toBe(669373); // Skubal
  });

  it('parses pitching lines + decision flags', async () => {
    const data = await fetchMlbBoxScore(745223);
    const skubal = data!.appearances.find(
      (a) => a.player.mlb_stats_id === 669373
    );
    expect(skubal).toBeDefined();
    expect(skubal!.decision).toBe('W');
    expect(skubal!.is_starter_pitcher).toBe(true);
    expect(skubal!.notable).toBe(true);
    expect(skubal!.pitching_line).toMatchObject({
      ip: '8.0',
      k: 12,
      er: 1,
      pitches: 102,
      strikes: 70,
    });
  });

  it('parses batting lines + flags multi-hit / HR as notable', async () => {
    const data = await fetchMlbBoxScore(745223);
    const raleigh = data!.appearances.find(
      (a) => a.player.mlb_stats_id === 596142
    );
    expect(raleigh).toBeDefined();
    expect(raleigh!.batting_line).toMatchObject({
      ab: 4,
      h: 2,
      hr: 1,
      rbi: 1,
    });
    expect(raleigh!.notable).toBe(true); // 2 hits + HR
    expect(raleigh!.batting_order).toBe(400);
  });

  it('does NOT flag a 0-for-4 single-K as notable', async () => {
    const data = await fetchMlbBoxScore(745223);
    const robles = data!.appearances.find(
      (a) => a.player.mlb_stats_id === 645302
    );
    expect(robles).toBeDefined();
    expect(robles!.notable).toBe(false);
    expect(robles!.batting_line).toMatchObject({ ab: 4, h: 0, k: 1 });
  });

  it('preserves bio fields for players', async () => {
    const data = await fetchMlbBoxScore(745223);
    const kirby = data!.appearances.find(
      (a) => a.player.mlb_stats_id === 669923
    );
    expect(kirby!.player).toMatchObject({
      mlb_stats_id: 669923,
      full_name: 'George Kirby',
      first_name: 'George',
      last_name: 'Kirby',
      primary_position: 'P',
      primary_number: '68',
      throws: 'R',
      debut_date: '2022-05-08',
    });
  });
});
