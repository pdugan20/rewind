import { expect, it } from 'vitest';
import { artworkArtistMatches } from './identity.js';

it.each([
  ['SÝNTHETIC‐ARTIST', 'Synthetic-Artist'],
  ['  Synthetic   Artist ', 'synthetic artist'],
  ['Synthetic’s', "Synthetic's"],
])('ignores typographic differences: %s / %s', (a, b) => {
  expect(artworkArtistMatches(a, b)).toBe(true);
});
it.each([
  ['Synthetic', 'Synthetic Artist'],
  ['Synthetic', 'The Synthetic'],
  ['Synthetic feat. Guest', 'Synthetic'],
  ['Synthetic One', 'Synthetic 1'],
  ['', ''],
])('retains distinct identities: %s / %s', (a, b) => {
  expect(artworkArtistMatches(a, b)).toBe(false);
});
