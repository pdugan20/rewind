// Holiday music album patterns (substring match, case-insensitive)
const HOLIDAY_ALBUM_PATTERNS = [
  'charlie brown christmas',
  'merry christmas',
  'white christmas',
  'christmas album',
  'holiday',
  'christmas songs',
];

// Holiday music track patterns (substring match, case-insensitive)
const HOLIDAY_TRACK_PATTERNS = [
  'jingle bell',
  'silent night',
  'santa claus',
  'deck the hall',
  'rudolph',
  'frosty the snowman',
  'winter wonderland',
  'o holy night',
  'little drummer boy',
  'away in a manger',
  'hark the herald',
  'o come all ye faithful',
  'we wish you a merry',
  'sleigh ride',
  'silver bells',
  'blue christmas',
  'last christmas',
  'christmas time',
  'holly jolly',
  'joy to the world',
];

// Artist-scoped exact track matches (case-insensitive)
const HOLIDAY_ARTIST_TRACKS: { artist: string; track: string }[] = [
  { artist: 'vince guaraldi', track: 'skating' },
  { artist: 'vince guaraldi', track: 'greensleeves' },
  { artist: 'vince guaraldi', track: 'linus and lucy' },
];

// Audiobook artist names (case-insensitive exact match)
const AUDIOBOOK_ARTISTS = [
  'stephen king',
  'thomas pynchon',
  'hunter s. thompson',
  'andy weir',
];

// Audiobook track patterns
const AUDIOBOOK_TRACK_PATTERNS = ['libby--open-'];

// Audiobook regex patterns
const AUDIOBOOK_TRACK_REGEXES = [
  /- Part \d+/i,
  /- Track \d+/i,
  /- \d{2,3}$/,
  / \(\d+\)$/,
];

export interface FilterableItem {
  artistName: string;
  albumName?: string;
  trackName?: string;
}

export function isHolidayMusic(item: FilterableItem): boolean {
  const albumLower = (item.albumName ?? '').toLowerCase();
  const trackLower = (item.trackName ?? '').toLowerCase();
  const artistLower = item.artistName.toLowerCase();

  // Check album patterns
  for (const pattern of HOLIDAY_ALBUM_PATTERNS) {
    if (albumLower.includes(pattern)) return true;
  }

  // Check track patterns
  for (const pattern of HOLIDAY_TRACK_PATTERNS) {
    if (trackLower.includes(pattern)) return true;
  }

  // Check artist-scoped exact track matches
  for (const entry of HOLIDAY_ARTIST_TRACKS) {
    if (artistLower.includes(entry.artist) && trackLower === entry.track) {
      return true;
    }
  }

  return false;
}

export function isAudiobook(item: FilterableItem): boolean {
  const artistLower = item.artistName.toLowerCase();
  const trackLower = (item.trackName ?? '').toLowerCase();

  // Check audiobook artists
  for (const artist of AUDIOBOOK_ARTISTS) {
    if (artistLower === artist) return true;
  }

  // Check audiobook track patterns
  for (const pattern of AUDIOBOOK_TRACK_PATTERNS) {
    if (trackLower.includes(pattern)) return true;
  }

  // Check audiobook regex patterns
  const trackName = item.trackName ?? '';
  for (const regex of AUDIOBOOK_TRACK_REGEXES) {
    if (regex.test(trackName)) return true;
  }

  return false;
}

export function isFiltered(item: FilterableItem): boolean {
  return isHolidayMusic(item) || isAudiobook(item);
}

/**
 * Over-fetch, filter, and re-rank strategy for top lists.
 * Takes the raw (over-fetched) list, filters out matched items,
 * re-ranks the remaining, and returns the desired count.
 */
export function filterAndRerank<T extends FilterableItem>(
  items: T[],
  limit: number
): T[] {
  const filtered = items.filter((item) => !isFiltered(item));
  return filtered.slice(0, limit);
}
