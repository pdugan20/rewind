/**
 * Genre allowlist and synonym normalization for Last.fm artist tags.
 *
 * Maps lowercase Last.fm tag names to canonical genre names. Tags not in
 * this map are discarded (e.g., "seen live", "female vocalists", artist
 * self-tags). Multiple spellings map to the same canonical name.
 */
export const GENRE_MAP: Record<string, string> = {
  // Rock
  rock: 'Rock',
  'classic rock': 'Classic Rock',
  alternative: 'Alternative',
  'alternative rock': 'Alternative',
  'indie rock': 'Indie Rock',
  indie: 'Indie',
  'punk rock': 'Punk',
  punk: 'Punk',
  'pop punk': 'Pop Punk',
  'post-punk': 'Post-Punk',
  grunge: 'Grunge',
  'hard rock': 'Hard Rock',
  'soft rock': 'Soft Rock',
  'progressive rock': 'Progressive Rock',
  'prog rock': 'Progressive Rock',
  'psychedelic rock': 'Psychedelic Rock',
  psychedelic: 'Psychedelic',
  'garage rock': 'Garage Rock',
  'post-rock': 'Post-Rock',
  'math rock': 'Math Rock',
  'noise rock': 'Noise Rock',
  'stoner rock': 'Stoner Rock',
  britpop: 'Britpop',
  'power pop': 'Power Pop',
  'pop rock': 'Pop Rock',
  shoegaze: 'Shoegaze',
  'dream pop': 'Dream Pop',
  'new wave': 'New Wave',
  'no wave': 'No Wave',

  // Metal
  metal: 'Metal',
  'heavy metal': 'Metal',
  'death metal': 'Death Metal',
  'black metal': 'Black Metal',
  'thrash metal': 'Thrash Metal',
  'doom metal': 'Doom Metal',
  'progressive metal': 'Progressive Metal',

  // Punk / Hardcore
  hardcore: 'Hardcore',
  'post-hardcore': 'Post-Hardcore',
  emo: 'Emo',
  screamo: 'Screamo',

  // Pop
  pop: 'Pop',
  synthpop: 'Synthpop',
  'synth-pop': 'Synthpop',
  electropop: 'Electropop',
  'art pop': 'Art Pop',
  'chamber pop': 'Chamber Pop',
  'country pop': 'Country Pop',
  'k-pop': 'K-Pop',
  'j-pop': 'J-Pop',

  // Hip-Hop / Rap
  'hip-hop': 'Hip-Hop',
  'hip hop': 'Hip-Hop',
  rap: 'Hip-Hop',
  'underground hip-hop': 'Underground Hip-Hop',
  'underground hip hop': 'Underground Hip-Hop',
  trap: 'Trap',
  drill: 'Drill',
  grime: 'Grime',
  'conscious hip-hop': 'Conscious Hip-Hop',
  'conscious hip hop': 'Conscious Hip-Hop',

  // Electronic
  electronic: 'Electronic',
  electronica: 'Electronic',
  dance: 'Dance',
  edm: 'EDM',
  house: 'House',
  'deep house': 'Deep House',
  techno: 'Techno',
  trance: 'Trance',
  ambient: 'Ambient',
  'drum and bass': 'Drum and Bass',
  dnb: 'Drum and Bass',
  dubstep: 'Dubstep',
  dub: 'Dub',
  idm: 'IDM',
  breakbeat: 'Breakbeat',
  'trip-hop': 'Trip-Hop',
  'trip hop': 'Trip-Hop',
  downtempo: 'Downtempo',
  'lo-fi': 'Lo-Fi',
  glitch: 'Glitch',
  industrial: 'Industrial',
  ebm: 'EBM',

  // Jazz
  jazz: 'Jazz',
  'jazz hop': 'Jazz Hop',
  'jazz rap': 'Jazz Hop',
  'acid jazz': 'Acid Jazz',
  'jazz fusion': 'Jazz Fusion',
  'smooth jazz': 'Smooth Jazz',
  'free jazz': 'Free Jazz',

  // Blues / Soul / R&B / Funk
  blues: 'Blues',
  soul: 'Soul',
  'neo-soul': 'Neo-Soul',
  'neo soul': 'Neo-Soul',
  'r&b': 'R&B',
  rnb: 'R&B',
  funk: 'Funk',
  'p-funk': 'P-Funk',
  motown: 'Motown',
  disco: 'Disco',
  'nu-disco': 'Nu-Disco',
  gospel: 'Gospel',

  // Country / Folk / Americana
  country: 'Country',
  'alt-country': 'Alt-Country',
  americana: 'Americana',
  folk: 'Folk',
  'folk rock': 'Folk Rock',
  'indie folk': 'Indie Folk',
  bluegrass: 'Bluegrass',
  'singer-songwriter': 'Singer-Songwriter',

  // World / Latin / Reggae
  reggae: 'Reggae',
  ska: 'Ska',
  latin: 'Latin',
  afrobeat: 'Afrobeat',
  afrobeats: 'Afrobeats',
  'bossa nova': 'Bossa Nova',
  world: 'World',
  'world music': 'World',

  // Classical / Soundtrack
  classical: 'Classical',
  'neo-classical': 'Neo-Classical',
  soundtrack: 'Soundtrack',
  'film score': 'Soundtrack',
  'new age': 'New Age',

  // Other
  experimental: 'Experimental',
  'avant-garde': 'Avant-Garde',
  noise: 'Noise',
};

export interface NormalizedTag {
  name: string;
  count: number;
}

/**
 * Resolves raw Last.fm tags into a primary genre and a list of normalized tags.
 *
 * Tags are matched against the allowlist in order of weight (highest first,
 * which is how Last.fm returns them). The first match becomes the primary genre.
 * Duplicate canonical names are collapsed (only the highest-weighted instance kept).
 */
export function resolveGenre(tags: Array<{ name: string; count: number }>): {
  genre: string | null;
  normalizedTags: NormalizedTag[];
} {
  const normalizedTags: NormalizedTag[] = [];
  const seen = new Set<string>();

  for (const tag of tags) {
    const canonical = GENRE_MAP[tag.name.toLowerCase()];
    if (canonical && !seen.has(canonical)) {
      seen.add(canonical);
      normalizedTags.push({ name: canonical, count: tag.count });
    }
  }

  return {
    genre: normalizedTags[0]?.name ?? null,
    normalizedTags,
  };
}
