import { expect, it } from 'vitest';
import { artworkArtistMatches } from './identity.js';

it.each([
  ['SÝNTHETIC‐ARTIST', 'Synthetic-Artist'],
  ['  Synthetic   Artist ', 'synthetic artist'],
  ['Synthetic’s', "Synthetic's"],
  ['Synthetic and Guest', 'Synthetic & Guest'],
])('ignores typographic differences: %s / %s', (a, b) => {
  expect(artworkArtistMatches(a, b)).toBe(true);
});
it.each([
  ['Synthetic', 'Synthetic Artist'],
  ['Synthetic', 'The Synthetic'],
  ['Synthetic feat. Guest', 'Synthetic'],
  ['Synthetic One', 'Synthetic 1'],
  ['Synthetic and Guest', 'Synthetic'],
  ['Synthetic and Guest', 'Synthetic & Other Guest'],
  ['', ''],
])('retains distinct identities: %s / %s', (a, b) => {
  expect(artworkArtistMatches(a, b)).toBe(false);
});
