import { describe, it, expect } from 'vitest';
import { inferEventType, stripVenueSuffix } from './enrich.js';

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
  ] as const)('strips %s → %s', (input, expected) => {
    expect(stripVenueSuffix(input)).toBe(expected);
  });
});
