import { describe, it, expect } from 'vitest';
import {
  inferEventType,
  stripVenueSuffix,
  formatSportsTitle,
  formatSportsSubtitle,
  canonicalGameTiming,
} from './enrich.js';
import type { SportsGameMatch } from '../sports/types.js';

describe('inferEventType', () => {
  it.each([
    ['Mariners vs Astros', 'T-Mobile Park', 'mlb_game', 'sports'],
    ['Texas Rangers at Seattle Mariners', null, 'mlb_game', 'sports'],
    ['Seahawks game', 'Lumen Field', 'nfl_game', 'sports'],
    ['Storm vs Mystics', 'Climate Pledge Arena', 'wnba_game', 'sports'],
    ['Sounders vs LAFC', 'Lumen Field', 'mls_game', 'sports'],
    ['Cardinal @ Huskies', 'Husky Stadium', 'ncaaf_game', 'sports'],
    ['UW basketball game', 'Alaska Airlines Arena', 'ncaab_game', 'sports'],
    ['Huskies game', null, 'ncaaf_game', 'sports'], // default to football
    ['Husky game', 'Husky Stadium', 'ncaaf_game', 'sports'], // singular too
    ['Phoebe Bridgers', 'Climate Pledge Arena', 'concert', 'music'],
    ['Show at the Crocodile', 'The Crocodile', 'concert', 'music'],
    ['Lunch with Jess', 'Cafe X', 'concert', 'music'], // catch-all → concert
  ] as const)(
    'infers "%s" + "%s" → %s/%s',
    (title, location, eventType, category) => {
      expect(inferEventType(title, location)).toEqual({
        event_type: eventType,
        category,
      });
    }
  );

  it('Huskies @ Hec Ed → ncaab_game (basketball venue)', () => {
    expect(inferEventType('Huskies basketball', 'Hec Ed Pavilion')).toEqual({
      event_type: 'ncaab_game',
      category: 'sports',
    });
  });

  it('case-insensitive', () => {
    expect(inferEventType('MARINERS!!', null).event_type).toBe('mlb_game');
  });
});

describe('stripVenueSuffix', () => {
  it.each([
    ['Phoebe Bridgers at Climate Pledge Arena', 'Phoebe Bridgers'],
    ['Odesza Concert @ Climate Pledge', 'Odesza Concert'],
    ['Dr. Dog - Neptune Theatre', 'Dr. Dog'],
    ['Just an artist name', 'Just an artist name'],
  ] as const)('strips %s -> %s', (input, expected) => {
    expect(stripVenueSuffix(input)).toBe(expected);
  });
});

describe('formatSportsTitle', () => {
  it('renders "<Home> vs <Away>" for a Mariners home game', () => {
    expect(
      formatSportsTitle(
        makeMatch({ home: 'Seattle Mariners', away: 'Cleveland Guardians' })
      )
    ).toBe('Seattle Mariners vs Cleveland Guardians');
  });

  it('handles single-word teams (Athletics)', () => {
    expect(
      formatSportsTitle(
        makeMatch({ home: 'Seattle Mariners', away: 'Athletics' })
      )
    ).toBe('Seattle Mariners vs Athletics');
  });
});

describe('formatSportsSubtitle', () => {
  it('renders score line with last-word short names', () => {
    expect(
      formatSportsSubtitle(
        makeMatch({
          home: 'Seattle Mariners',
          away: 'Cleveland Guardians',
          home_score: 4,
          away_score: 3,
        })
      )
    ).toBe('Mariners 4, Guardians 3');
  });

  it('returns null pre-game (scores not yet available)', () => {
    expect(
      formatSportsSubtitle(
        makeMatch({
          home: 'Seattle Mariners',
          away: 'Cleveland Guardians',
          home_score: null,
          away_score: null,
        })
      )
    ).toBeNull();
  });

  it('handles single-word teams (Athletics)', () => {
    expect(
      formatSportsSubtitle(
        makeMatch({
          home: 'Seattle Mariners',
          away: 'Athletics',
          home_score: 3,
          away_score: 2,
        })
      )
    ).toBe('Mariners 3, Athletics 2');
  });
});

function makeMatch(opts: {
  home: string;
  away: string;
  home_score?: number | null;
  away_score?: number | null;
}): SportsGameMatch {
  return {
    external_id: '1',
    external_source: 'mlb_stats_api',
    league: 'mlb',
    season: 2024,
    game_type: 'R',
    game_date: '2024-06-01',
    game_datetime_utc: '2024-06-01T19:10:00Z',
    status: 'Final',
    home_team: { id: 1, name: opts.home },
    away_team: { id: 2, name: opts.away },
    // Distinguish "not passed" (use 5/3 default) from "passed null"
    // (caller is asserting pre-game / no score yet).
    home_score: 'home_score' in opts ? (opts.home_score ?? null) : 5,
    away_score: 'away_score' in opts ? (opts.away_score ?? null) : 3,
    home_is_winner: null,
    away_is_winner: null,
  };
}

describe('canonicalGameTiming', () => {
  const game = {
    game_date: '2026-05-16',
    game_datetime_utc: '2026-05-16T23:15:00Z',
  };

  it('keeps a complete local start on the game day', () => {
    expect(canonicalGameTiming(game, '2026-05-16T16:15:00-07:00')).toEqual({
      event_date: '2026-05-16',
      event_datetime: '2026-05-16T16:15:00-07:00',
    });
  });

  it('replaces a yearless vendor start with the scheduled start', () => {
    expect(
      canonicalGameTiming(
        { game_date: '2025-08-08', game_datetime_utc: '2025-08-09T01:40:00Z' },
        '08-08T18:40'
      )
    ).toEqual({
      event_date: '2025-08-08',
      event_datetime: '2025-08-09T01:40:00Z',
    });
  });

  it('replaces a start from another day or year', () => {
    expect(canonicalGameTiming(game, '2021-05-16T13:10')).toEqual({
      event_date: '2026-05-16',
      event_datetime: '2026-05-16T23:15:00Z',
    });
  });

  it('uses the scheduled start when the source has none', () => {
    expect(canonicalGameTiming(game, null).event_datetime).toBe(
      '2026-05-16T23:15:00Z'
    );
  });
});
