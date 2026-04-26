import { describe, it, expect } from 'vitest';
import { positionClass } from './enrich-espn-ids-by-search.js';

describe('positionClass', () => {
  it.each([
    ['P', 'pitcher'],
    ['SP', 'pitcher'],
    ['RP', 'pitcher'],
    ['CL', 'pitcher'],
    ['CP', 'pitcher'],
    ['LR', 'pitcher'],
    ['MR', 'pitcher'],
    ['SU', 'pitcher'],
    ['C', 'catcher'],
    ['1B', 'infield'],
    ['2B', 'infield'],
    ['3B', 'infield'],
    ['SS', 'infield'],
    ['IF', 'infield'],
    ['LF', 'outfield'],
    ['CF', 'outfield'],
    ['RF', 'outfield'],
    ['OF', 'outfield'],
    ['DH', 'dh'],
    [null, 'unknown'],
    [undefined, 'unknown'],
    ['', 'unknown'],
    ['UTIL', 'unknown'],
    // case insensitivity
    ['p', 'pitcher'],
    ['1b', 'infield'],
  ] as const)('classifies %s -> %s', (abbr, expected) => {
    expect(positionClass(abbr)).toBe(expected);
  });
});
