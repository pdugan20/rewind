/**
 * Discogs Collection Bulk Add Script
 *
 * Adds missing physical media (CDs and vinyl) to a Discogs collection.
 * Searches for the best matching US release by format, then adds via API.
 *
 * Prerequisites:
 *   1. .dev.vars contains DISCOGS_PERSONAL_TOKEN and DISCOGS_USERNAME
 *
 * Usage:
 *   npx tsx scripts/add-discogs-collection.ts
 *   npx tsx scripts/add-discogs-collection.ts --dry-run
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const envPath = resolve(import.meta.dirname ?? '.', '../.dev.vars');
const envFile = readFileSync(envPath, 'utf-8');
const env: Record<string, string> = {};
for (const line of envFile.split('\n')) {
  const [key, ...rest] = line.split('=');
  if (key && rest.length) env[key.trim()] = rest.join('=').trim();
}

const DISCOGS_TOKEN = env.DISCOGS_PERSONAL_TOKEN;
const DISCOGS_USERNAME = env.DISCOGS_USERNAME;
const RATE_LIMIT_MS = 1100; // Discogs: 60 req/min
const DRY_RUN = process.argv.includes('--dry-run');

if (!DISCOGS_TOKEN || !DISCOGS_USERNAME) {
  console.error('[ERROR] Missing DISCOGS_PERSONAL_TOKEN or DISCOGS_USERNAME in .dev.vars');
  process.exit(1);
}

// --- Types ---

interface CollectionItem {
  artist: string;
  title: string;
  format: 'Vinyl' | 'CD';
  notes?: string; // e.g. "variant 2 of 5"
  discogsId?: number; // Override: skip search, use this release ID directly
}

interface DiscogsSearchResult {
  id: number;
  title: string;
  year: string;
  format: string[];
  country: string;
  label: string[];
  uri: string;
  community: { have: number; want: number };
}

interface ExistingItem {
  id: number;
  instanceId: number;
  artist: string;
  title: string;
  formats: string[];
}

// --- Items to add ---
// Each entry: { artist, title, format }
// Duplicates are intentional (multiple pressings)

const ITEMS_TO_ADD: CollectionItem[] = [
  // === CDs (33) ===
  { artist: 'Various', title: 'Layer Cake (Music from the Motion Picture)', format: 'CD' },
  { artist: 'Taylor Swift', title: '1989 (Taylor\'s Version)', format: 'CD' },
  { artist: 'The Black Keys', title: 'Thickfreakness', format: 'CD' },
  { artist: 'The Black Keys', title: 'Attack & Release', format: 'CD' },
  { artist: 'The Black Keys', title: 'Turn Blue', format: 'CD' },
  { artist: 'Taylor Swift', title: 'Midnights', format: 'CD' },
  { artist: 'Taylor Swift', title: 'Folklore', format: 'CD' },
  { artist: 'Taylor Swift', title: 'Speak Now (Taylor\'s Version)', format: 'CD' },
  { artist: 'Taylor Swift', title: 'The Tortured Poets Department', format: 'CD' },
  { artist: 'Nirvana', title: 'MTV Unplugged In New York', format: 'CD' },
  { artist: 'Nirvana', title: 'From The Muddy Banks Of The Wishkah', format: 'CD' },
  { artist: 'Nirvana', title: 'Sliver: The Best Of The Box', format: 'CD' },
  { artist: 'Nirvana', title: 'Nevermind', format: 'CD' },
  { artist: 'Nirvana', title: 'In Utero', format: 'CD' },
  { artist: 'Nirvana', title: 'Nirvana', format: 'CD' },
  { artist: 'Bob Dylan', title: 'The Freewheelin\' Bob Dylan', format: 'CD' },
  { artist: 'Bob Dylan', title: 'Another Side Of Bob Dylan', format: 'CD' },
  { artist: 'Bob Dylan', title: 'Highway 61 Revisited', format: 'CD' },
  { artist: 'Bob Dylan', title: 'Bob Dylan', format: 'CD', discogsId: 2420778 },
  { artist: 'Bob Dylan', title: 'Blood On The Tracks', format: 'CD' },
  { artist: 'Weezer', title: 'Weezer (Green Album)', format: 'CD' },
  { artist: 'Weezer', title: 'Weezer (Blue Album)', format: 'CD' },
  { artist: 'Various', title: 'Juno (Music From The Motion Picture)', format: 'CD' },
  { artist: 'Elmer Bernstein', title: 'The Magnificent Seven (Original Soundtrack)', format: 'CD' },
  { artist: 'Adam Sandler', title: 'What The Hell Happened To Me?', format: 'CD' },
  { artist: 'Taylor Swift', title: 'The Tortured Poets Department', format: 'CD', notes: 'second copy' },
  { artist: 'The Black Keys', title: 'El Camino', format: 'CD' },
  { artist: 'Johnny Cash', title: 'At Folsom Prison', format: 'CD' },
  { artist: 'Adam Sandler', title: 'Stan And Judy\'s Kid', format: 'CD' },
  { artist: 'Adam Sandler', title: 'They\'re All Gonna Laugh At You!', format: 'CD' },
  { artist: 'Chris Rock', title: 'Bigger & Blacker', format: 'CD' },
  { artist: 'Adam Sandler', title: 'What\'s Your Name?', format: 'CD' },
  { artist: 'Griff', title: 'Vertigo', format: 'CD', discogsId: 31205986 },

  // === Vinyl Shelf 1 (38) ===
  { artist: 'Taylor Swift', title: '1989 (Taylor\'s Version)', format: 'Vinyl', discogsId: 28638091 },
  { artist: 'Taylor Swift', title: 'Life Of A Showgirl', format: 'Vinyl' },
  { artist: 'Taylor Swift', title: 'Lover (Live From Paris)', format: 'Vinyl', discogsId: 32796732 },
  { artist: 'Nirvana', title: 'Nevermind', format: 'Vinyl' },
  { artist: 'Frank Sinatra', title: 'September Of My Years', format: 'Vinyl' },
  { artist: 'Frank Sinatra', title: 'All The Way', format: 'Vinyl', discogsId: 2194000 },
  { artist: 'Neil Young', title: 'Everybody Knows This Is Nowhere', format: 'Vinyl' },
  { artist: 'Wilco', title: 'Yankee Hotel Foxtrot', format: 'Vinyl' },
  { artist: 'Various', title: 'Easy Rider (Music From The Soundtrack)', format: 'Vinyl' },
  { artist: 'The Rolling Stones', title: 'Aftermath', format: 'Vinyl' },
  { artist: 'The Beatles', title: 'Magical Mystery Tour', format: 'Vinyl' },
  { artist: 'The Rolling Stones', title: 'Sticky Fingers', format: 'Vinyl' },
  { artist: 'Led Zeppelin', title: 'Led Zeppelin IV', format: 'Vinyl', discogsId: 17765626 },
  { artist: 'The Doobie Brothers', title: 'Best Of The Doobies', format: 'Vinyl' },
  { artist: 'The Beatles', title: 'Abbey Road', format: 'Vinyl' },
  { artist: 'The Beatles', title: 'Hey Jude', format: 'Vinyl' },
  { artist: 'King Tuff', title: 'Black Moon Spell', format: 'Vinyl' },
  { artist: 'Lana Del Rey', title: 'Paradise', format: 'Vinyl' },
  { artist: 'Eminem', title: 'The Eminem Show', format: 'Vinyl' },
  { artist: 'Courtney Barnett', title: 'Sometimes I Sit And Think, And Sometimes I Just Sit', format: 'Vinyl' },
  { artist: 'Beastie Boys', title: 'Ill Communication', format: 'Vinyl' },
  { artist: 'Ramones', title: 'Ramones', format: 'Vinyl' },
  { artist: 'The Beatles', title: 'Revolver', format: 'Vinyl' },
  { artist: 'Lana Del Rey', title: 'Ultraviolence', format: 'Vinyl' },
  { artist: 'Hotpipes', title: 'Dust', format: 'Vinyl' },
  { artist: 'Ray Charles', title: 'Crying Time', format: 'Vinyl' },
  { artist: 'Robin Williams', title: 'A Night At The Met', format: 'Vinyl' },
  { artist: 'Led Zeppelin', title: 'Coda', format: 'Vinyl' },
  { artist: 'Eagles', title: 'Hotel California', format: 'Vinyl' },
  { artist: 'Wings', title: 'At The Speed Of Sound', format: 'Vinyl' },
  { artist: 'Ratatat', title: 'LP4', format: 'Vinyl' },
  { artist: 'Billy Joel', title: 'Turnstiles', format: 'Vinyl' },
  { artist: 'Gorillaz', title: 'Plastic Beach', format: 'Vinyl' },
  { artist: 'Weezer', title: 'Everything Will Be Alright In The End', format: 'Vinyl' },
  { artist: 'Weezer', title: 'The Lion And The Witch', format: 'Vinyl' },
  { artist: 'Weezer', title: 'Pinkerton', format: 'Vinyl' },
  { artist: 'Vance Joy', title: 'Nation Of Two', format: 'Vinyl' },
  { artist: 'Sabrina Carpenter', title: 'Man\'s Best Friend', format: 'Vinyl' },

  // === Vinyl Shelf 2 (40) ===
  { artist: 'Johnny Cash', title: 'At Folsom Prison', format: 'Vinyl' },
  { artist: 'Justin Hurwitz', title: 'La La Land (Original Motion Picture Soundtrack)', format: 'Vinyl', discogsId: 9740448 },
  { artist: 'N.W.A.', title: 'Straight Outta Compton', format: 'Vinyl' },
  { artist: 'Louis C.K.', title: 'Oh My God', format: 'Vinyl' },
  { artist: 'Jamie XX', title: 'In Colour', format: 'Vinyl' },
  { artist: 'Pepper Rabbit', title: 'Red Velvet Snow Ball', format: 'Vinyl' },
  { artist: 'Father John Misty', title: 'I Love You, Honeybear', format: 'Vinyl' },
  { artist: 'Neil Young', title: 'Harvest', format: 'Vinyl' },
  { artist: 'Neil Young', title: 'After The Gold Rush', format: 'Vinyl' },
  { artist: 'Glen Campbell', title: 'Wichita Lineman', format: 'Vinyl' },
  { artist: 'Fleetwood Mac', title: 'Kiln House', format: 'Vinyl' },
  { artist: 'The Doors', title: 'The Doors', format: 'Vinyl' },
  { artist: 'The Rolling Stones', title: 'Let It Bleed', format: 'Vinyl' },
  { artist: 'The Rolling Stones', title: 'Flowers', format: 'Vinyl' },
  { artist: 'The Mamas & The Papas', title: 'Greatest Hits', format: 'Vinyl' },
  { artist: 'Various', title: 'Pulp Fiction (Music From The Motion Picture)', format: 'Vinyl' },
  { artist: 'Wings', title: 'Band On The Run', format: 'Vinyl' },
  { artist: 'Ice Cube', title: 'AmeriKKKa\'s Most Wanted', format: 'Vinyl' },
  { artist: 'The Doors', title: 'Waiting For The Sun', format: 'Vinyl' },
  { artist: 'Taylor Swift', title: 'Speak Now (Taylor\'s Version)', format: 'Vinyl' },
  { artist: 'Taylor Swift', title: 'The Tortured Poets Department', format: 'Vinyl' },
  { artist: 'Taylor Swift', title: 'The Tortured Poets Department', format: 'Vinyl', notes: 'second copy' },
  { artist: 'Various', title: '30th Century Records Compilation, Volume 1', format: 'Vinyl', discogsId: 7924501 },
  { artist: 'Weezer', title: 'Weezer (White Album)', format: 'Vinyl' },
  { artist: 'Starfucker', title: 'Miracle Mile', format: 'Vinyl' },
  { artist: 'Bob Dylan', title: 'In Concert (Brandeis University 1963)', format: 'Vinyl' },
  { artist: 'The Beatles', title: 'The Beatles (White Album)', format: 'Vinyl' },
  { artist: 'The Rolling Stones', title: 'Exile On Main St.', format: 'Vinyl' },
  { artist: 'The Grateful Dead', title: 'American Beauty', format: 'Vinyl' },
  { artist: 'Wu-Tang Clan', title: 'Enter The Wu-Tang (36 Chambers)', format: 'Vinyl' },
  { artist: 'The Rolling Stones', title: 'Beggars Banquet', format: 'Vinyl' },
  { artist: 'The Rolling Stones', title: 'Out Of Our Heads', format: 'Vinyl' },
  { artist: 'Bob Dylan', title: 'John Wesley Harding', format: 'Vinyl' },
  { artist: '2Pac', title: 'All Eyez On Me', format: 'Vinyl' },
  { artist: 'John Coltrane', title: 'Coltrane', format: 'Vinyl', discogsId: 3016396 },
  { artist: 'Wings', title: 'Venus And Mars', format: 'Vinyl' },
  { artist: 'The Black Keys', title: 'The Big Come Up', format: 'Vinyl' },
  { artist: 'Nirvana', title: 'Bleach', format: 'Vinyl' },
  { artist: 'George Carlin', title: 'Class Clown', format: 'Vinyl' },
  { artist: 'Beastie Boys', title: 'Hot Sauce Committee Part Two', format: 'Vinyl' },

  // === Vinyl Shelf 3 (38) ===
  { artist: 'Taylor Swift', title: '1989 (Taylor\'s Version)', format: 'Vinyl', notes: 'copy 2', discogsId: 28714936 },
  { artist: 'Taylor Swift', title: '1989 (Taylor\'s Version)', format: 'Vinyl', notes: 'copy 3', discogsId: 28714750 },
  { artist: 'Taylor Swift', title: '1989 (Taylor\'s Version)', format: 'Vinyl', notes: 'copy 4', discogsId: 28714732 },
  { artist: 'Taylor Swift', title: '1989 (Taylor\'s Version)', format: 'Vinyl', notes: 'copy 5', discogsId: 28714738 },
  { artist: 'Eagles', title: 'Their Greatest Hits, Volumes 1 & 2', format: 'Vinyl' },
  { artist: 'David Bowie', title: 'The Rise And Fall Of Ziggy Stardust And The Spiders From Mars', format: 'Vinyl' },
  { artist: 'Wings', title: 'Wings Over America', format: 'Vinyl' },
  { artist: 'Beastie Boys', title: 'To The 5 Boroughs', format: 'Vinyl' },
  { artist: 'Bon Iver', title: '22, A Million', format: 'Vinyl' },
  { artist: 'Taylor Swift', title: 'Midnights', format: 'Vinyl' },
  { artist: 'Taylor Swift', title: 'Midnights', format: 'Vinyl', notes: 'copy 2' },
  { artist: 'Beastie Boys', title: 'Paul\'s Boutique', format: 'Vinyl' },
  { artist: 'Nirvana', title: 'Pennyroyal Tea', format: 'Vinyl', discogsId: 5610084 },
  { artist: 'Creedence Clearwater Revival', title: 'Willy And The Poor Boys', format: 'Vinyl' },
  { artist: 'Jefferson Airplane', title: 'Volunteers', format: 'Vinyl', discogsId: 1305465 },
  { artist: 'The Plastic Ono Band', title: 'Live Peace In Toronto 1969', format: 'Vinyl' },
  { artist: 'The Black Keys', title: 'Rubber Factory', format: 'Vinyl' },
  { artist: 'Sylvan Esso', title: 'What Now', format: 'Vinyl' },
  { artist: 'Eddie Murphy', title: 'Comedian', format: 'Vinyl' },
  { artist: 'The Who', title: 'Live At Leeds', format: 'Vinyl' },
  { artist: 'The Who', title: 'Tommy', format: 'Vinyl' },
  { artist: 'Sabrina Carpenter', title: 'Short n\' Sweet', format: 'Vinyl' },
  { artist: 'Alabama Shakes', title: 'Boys & Girls', format: 'Vinyl' },
  { artist: 'Beastie Boys', title: 'Hello Nasty', format: 'Vinyl' },
  { artist: 'A Tribe Called Quest', title: 'Midnight Marauders', format: 'Vinyl' },
  { artist: 'Miles Davis', title: 'Kind Of Blue', format: 'Vinyl' },
  { artist: 'The Velvet Underground', title: 'Loaded', format: 'Vinyl' },
  { artist: 'Etta James', title: 'At Last!', format: 'Vinyl' },
  { artist: 'Frank Sinatra', title: 'Try A Little Tenderness', format: 'Vinyl' },
  { artist: 'The Beach Boys', title: 'Pet Sounds', format: 'Vinyl' },
  { artist: 'Steve Martin', title: 'Let\'s Get Small', format: 'Vinyl' },
  { artist: 'The Rolling Stones', title: 'Big Hits (High Tide And Green Grass)', format: 'Vinyl' },
  { artist: 'John Lennon', title: 'Imagine', format: 'Vinyl' },
  { artist: 'Johnny Cash', title: 'At San Quentin', format: 'Vinyl' },
  { artist: 'Ratatat', title: 'Magnifique', format: 'Vinyl' },
  { artist: 'Wilco', title: 'Star Wars', format: 'Vinyl' },
  { artist: 'Various', title: 'High Fidelity (Original Soundtrack)', format: 'Vinyl' },
  { artist: 'Don McLean', title: 'American Pie', format: 'Vinyl' },
  { artist: 'The War On Drugs', title: 'Lost In The Dream', format: 'Vinyl' },
  { artist: 'Bob Frank', title: 'Bob Frank', format: 'Vinyl' },

  // === Vinyl Shelf 4 (41) ===
  { artist: 'Taylor Swift', title: 'Life Of A Showgirl', format: 'Vinyl', notes: 'copy 2' },
  { artist: 'Taylor Swift', title: 'Life Of A Showgirl', format: 'Vinyl', notes: 'copy 3' },
  { artist: 'Taylor Swift', title: 'Life Of A Showgirl', format: 'Vinyl', notes: 'copy 4' },
  { artist: 'Taylor Swift', title: 'Folklore', format: 'Vinyl' },
  { artist: 'Beyonce', title: 'Cowboy Carter', format: 'Vinyl' },
  { artist: 'The Beach Boys', title: 'The Beach Boys\' Christmas Album', format: 'Vinyl' },
  { artist: 'Frank Sinatra', title: 'A Jolly Christmas From Frank Sinatra', format: 'Vinyl' },
  { artist: 'Jack + Eliza', title: 'Gentle Warnings', format: 'Vinyl' },
  { artist: 'Ella Fitzgerald', title: 'Ella Wishes You A Swinging Christmas', format: 'Vinyl' },
  { artist: 'Bing Crosby', title: 'Christmas Classics', format: 'Vinyl' },
  { artist: 'Nirvana', title: 'In Utero', format: 'Vinyl' },
  { artist: 'Common', title: 'Resurrection', format: 'Vinyl' },
  { artist: 'Dr. Dre', title: 'The Chronic', format: 'Vinyl' },
  { artist: 'Fleet Foxes', title: 'Fleet Foxes', format: 'Vinyl' },
  { artist: 'Beastie Boys', title: 'The Mix-Up', format: 'Vinyl' },
  { artist: 'Buddy Holly', title: 'For The First Time Anywhere', format: 'Vinyl' },
  { artist: 'Beirut', title: 'The Flying Club Cup', format: 'Vinyl' },
  { artist: 'The Beatles', title: '1', format: 'Vinyl', discogsId: 7790160 },
  { artist: 'The Black Keys', title: 'Thickfreakness', format: 'Vinyl' },
  { artist: 'John Coltrane', title: 'Coltrane Jazz', format: 'Vinyl', discogsId: 645553 },
  { artist: 'Paul And Linda McCartney', title: 'Ram', format: 'Vinyl' },
  { artist: 'Al Green', title: 'I\'m Still In Love With You', format: 'Vinyl' },
  { artist: 'Billy Joel', title: 'An Innocent Man', format: 'Vinyl' },
  { artist: 'Woody Guthrie', title: 'Poor Boy', format: 'Vinyl', discogsId: 2291090 },
  { artist: 'Bob Dylan', title: 'Blonde On Blonde', format: 'Vinyl' },
  { artist: 'Bob Dylan', title: 'The Times They Are A-Changin\'', format: 'Vinyl' },
  { artist: 'Bob Dylan', title: 'Nashville Skyline', format: 'Vinyl' },
  { artist: 'Bob Dylan', title: 'Blood On The Tracks', format: 'Vinyl' },
  { artist: 'The Shins', title: 'Wincing The Night Away', format: 'Vinyl' },
  { artist: 'Taylor Swift', title: 'Folklore', format: 'Vinyl', notes: 'copy 2' },
  { artist: 'Ratatat', title: 'Classics', format: 'Vinyl' },
  { artist: 'Weezer', title: 'Weezer (Blue Album)', format: 'Vinyl' },
  { artist: 'Otis Redding', title: 'In Person At The Whisky A Go Go', format: 'Vinyl' },
  { artist: 'Fleetwood Mac', title: 'Rumours', format: 'Vinyl' },
  { artist: 'Nirvana', title: 'MTV Unplugged In New York', format: 'Vinyl' },
  { artist: 'Billy Joel', title: 'The Stranger', format: 'Vinyl' },
  { artist: 'The Black Keys', title: 'Turn Blue', format: 'Vinyl' },
  { artist: 'A Tribe Called Quest', title: 'We Got It From Here... Thank You 4 Your Service', format: 'Vinyl' },
  { artist: 'Various', title: 'Jackie Brown (Music From The Miramax Motion Picture)', format: 'Vinyl' },
  { artist: 'R.L. Burnside', title: 'Too Bad Jim', format: 'Vinyl' },
  { artist: 'Billy Joel', title: 'Piano Man', format: 'Vinyl' },
  { artist: 'Leon Bridges', title: 'Coming Home', format: 'Vinyl' },
  { artist: 'Lord Huron', title: 'Strange Trails', format: 'Vinyl' },
];

// --- Helpers ---

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function discogsGet(path: string, params?: Record<string, string>): Promise<unknown> {
  const url = new URL(`https://api.discogs.com${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  }
  const res = await fetch(url.toString(), {
    headers: {
      Authorization: `Discogs token=${DISCOGS_TOKEN}`,
      'User-Agent': 'RewindAPI/1.0',
    },
  });
  if (res.status === 429) {
    const retryAfter = parseInt(res.headers.get('Retry-After') || '5', 10);
    console.log(`[RATE LIMIT] Waiting ${retryAfter}s...`);
    await sleep(retryAfter * 1000);
    return discogsGet(path, params);
  }
  if (!res.ok) {
    throw new Error(`Discogs API error: ${res.status} ${res.statusText} for ${path}`);
  }
  return res.json();
}

async function discogsPost(path: string): Promise<unknown> {
  const url = `https://api.discogs.com${path}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Discogs token=${DISCOGS_TOKEN}`,
      'User-Agent': 'RewindAPI/1.0',
      'Content-Type': 'application/json',
    },
  });
  if (res.status === 429) {
    const retryAfter = parseInt(res.headers.get('Retry-After') || '5', 10);
    console.log(`[RATE LIMIT] Waiting ${retryAfter}s...`);
    await sleep(retryAfter * 1000);
    return discogsPost(path);
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Discogs API error: ${res.status} ${res.statusText} - ${body}`);
  }
  return res.json();
}

// --- Fetch existing collection ---

async function fetchExistingCollection(): Promise<ExistingItem[]> {
  const items: ExistingItem[] = [];
  let page = 1;
  let totalPages = 1;

  while (page <= totalPages) {
    const data = (await discogsGet(
      `/users/${DISCOGS_USERNAME}/collection/folders/0/releases`,
      { page: String(page), per_page: '100' }
    )) as {
      pagination: { pages: number };
      releases: Array<{
        id: number;
        instance_id: number;
        basic_information: {
          title: string;
          artists: Array<{ name: string }>;
          formats: Array<{ name: string }>;
        };
      }>;
    };

    totalPages = data.pagination.pages;
    for (const r of data.releases) {
      items.push({
        id: r.id,
        instanceId: r.instance_id,
        artist: r.basic_information.artists.map((a) => a.name).join(', '),
        title: r.basic_information.title,
        formats: r.basic_information.formats.map((f) => f.name),
      });
    }
    page++;
    if (page <= totalPages) await sleep(RATE_LIMIT_MS);
  }

  return items;
}

// --- Search for a release ---

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/['']/g, "'")
    .replace(/[""]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

async function searchRelease(
  artist: string,
  title: string,
  format: 'Vinyl' | 'CD'
): Promise<{ releaseId: number; displayTitle: string; year: string; country: string } | null> {
  // Search with artist + title + format
  const query = `${artist} ${title}`;
  const data = (await discogsGet('/database/search', {
    q: query,
    type: 'release',
    format: format,
    per_page: '10',
  })) as { results: DiscogsSearchResult[] };

  if (!data.results || data.results.length === 0) {
    // Retry without format filter
    const fallback = (await discogsGet('/database/search', {
      q: query,
      type: 'release',
      per_page: '10',
    })) as { results: DiscogsSearchResult[] };
    await sleep(RATE_LIMIT_MS);

    if (!fallback.results || fallback.results.length === 0) return null;

    // Pick the one with highest community.have
    const best = fallback.results.sort(
      (a, b) => (b.community?.have || 0) - (a.community?.have || 0)
    )[0];
    return {
      releaseId: best.id,
      displayTitle: best.title,
      year: best.year || '?',
      country: best.country || '?',
    };
  }

  // Prefer US releases, then sort by community.have (most common pressing)
  const usReleases = data.results.filter(
    (r) => r.country === 'US' || r.country === 'USA'
  );
  const pool = usReleases.length > 0 ? usReleases : data.results;
  const best = pool.sort(
    (a, b) => (b.community?.have || 0) - (a.community?.have || 0)
  )[0];

  return {
    releaseId: best.id,
    displayTitle: best.title,
    year: best.year || '?',
    country: best.country || '?',
  };
}

// --- Check if an item already exists in collection ---

function isAlreadyInCollection(
  existing: ExistingItem[],
  releaseId: number
): number {
  return existing.filter((e) => e.id === releaseId).length;
}

// --- Main ---

async function main() {
  console.log(`[INFO] Discogs Collection Bulk Add${DRY_RUN ? ' (DRY RUN)' : ''}`);
  console.log(`[INFO] Total items to process: ${ITEMS_TO_ADD.length}`);
  console.log('');

  console.log('[INFO] Fetching existing collection...');
  const existing = await fetchExistingCollection();
  console.log(`[INFO] Found ${existing.length} existing items`);
  console.log('');

  let added = 0;
  let skipped = 0;
  let failed = 0;
  const failures: Array<{ artist: string; title: string; format: string; reason: string }> = [];

  // Track how many times we've added each release ID in this run
  // (for handling multiple copies of the same album)
  const addedThisRun = new Map<number, number>();

  for (let i = 0; i < ITEMS_TO_ADD.length; i++) {
    const item = ITEMS_TO_ADD[i];
    const label = `[${i + 1}/${ITEMS_TO_ADD.length}]`;

    process.stdout.write(`${label} ${item.artist} - ${item.title} [${item.format}]...`);

    try {
      let result: { releaseId: number; displayTitle: string; year: string; country: string } | null;

      if (item.discogsId) {
        // Use the override ID directly, fetch display info
        const release = (await discogsGet(`/releases/${item.discogsId}`)) as {
          title: string;
          year: number;
          country: string;
          artists: Array<{ name: string }>;
        };
        await sleep(RATE_LIMIT_MS);
        const artistName = release.artists?.map((a) => a.name).join(', ') || item.artist;
        result = {
          releaseId: item.discogsId,
          displayTitle: `${artistName} - ${release.title}`,
          year: String(release.year || '?'),
          country: release.country || '?',
        };
      } else {
        result = await searchRelease(item.artist, item.title, item.format);
        await sleep(RATE_LIMIT_MS);
      }

      if (!result) {
        console.log(' NOT FOUND');
        failures.push({
          artist: item.artist,
          title: item.title,
          format: item.format,
          reason: 'No Discogs release found',
        });
        failed++;
        continue;
      }

      // Count existing copies in collection + copies added this run
      const existingCount = isAlreadyInCollection(existing, result.releaseId);
      const addedCount = addedThisRun.get(result.releaseId) || 0;
      const totalCopies = existingCount + addedCount;

      // For items with notes (explicit duplicates), we want to add regardless
      // For items without notes, skip if already exists
      if (totalCopies > 0 && !item.notes) {
        console.log(` SKIP (already in collection as ${existing.find(e => e.id === result.releaseId)?.formats.join(', ') || item.format})`);
        skipped++;
        continue;
      }

      if (DRY_RUN) {
        console.log(` WOULD ADD: ${result.displayTitle} (${result.year}, ${result.country})`);
        added++;
      } else {
        await discogsPost(
          `/users/${DISCOGS_USERNAME}/collection/folders/1/releases/${result.releaseId}`
        );
        await sleep(RATE_LIMIT_MS);
        console.log(` ADDED: ${result.displayTitle} (${result.year}, ${result.country})`);
        added++;
      }

      addedThisRun.set(result.releaseId, addedCount + 1);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(` ERROR: ${msg}`);
      failures.push({
        artist: item.artist,
        title: item.title,
        format: item.format,
        reason: msg,
      });
      failed++;
    }
  }

  console.log('');
  console.log('--- Summary ---');
  console.log(`[INFO] Added: ${added}`);
  console.log(`[INFO] Skipped (already exists): ${skipped}`);
  console.log(`[INFO] Failed: ${failed}`);

  if (failures.length > 0) {
    console.log('');
    console.log('--- Failures ---');
    for (const f of failures) {
      console.log(`  ${f.artist} - ${f.title} [${f.format}]: ${f.reason}`);
    }
  }
}

main().catch((err) => {
  console.error('[ERROR] Fatal:', err);
  process.exit(1);
});
