/**
 * Text normalizer applied to both FTS index inputs and search queries.
 *
 * The main job is to make dotted acronyms (S.N.L., U.S.A., A.I.) match
 * their undotted form. FTS5's unicode61 tokenizer splits on `.` so
 * "S.N.L." becomes three single-letter tokens -- unsearchable. We collapse
 * these at both index and query time so both sides resolve to `snl`.
 *
 * Regular sentence punctuation (foo.bar, sentence ends) is NOT touched.
 * The acronym rule requires at least two `letter.` runs in a row.
 */

const ACRONYM_RE = /\b(?:[a-z]\.){2,}[a-z]?/g;
const SMART_QUOTES_RE = /[‘’“”]/g;
const WHITESPACE_RE = /\s+/g;

export function normalizeForSearch(s: string | null | undefined): string {
  if (!s) return '';

  let out = s.normalize('NFKC').toLocaleLowerCase('en');
  out = out.replace(ACRONYM_RE, (m) => m.replace(/\./g, ''));
  out = out.replace(SMART_QUOTES_RE, '');
  out = out.replace(WHITESPACE_RE, ' ').trim();

  return out;
}
