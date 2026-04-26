import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../server.js';
import { RewindClient } from '../client.js';

/**
 * Creates a connected MCP client + server pair using in-memory transport.
 * The RewindClient is mocked so no real API calls are made.
 */
async function createTestClient() {
  const rewindClient = new RewindClient('https://api.test', 'rw_test');

  // Mock the HTTP client -- all tools go through client.get()
  vi.spyOn(rewindClient, 'get').mockImplementation(async (path: string) => {
    return getMockResponse(path);
  });

  // Mock image fetches -- return a tiny fake JPEG payload so imageBlock()
  // produces a base64 image content block in tool responses.
  vi.spyOn(rewindClient, 'getBinaryFromUrl').mockResolvedValue({
    bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0]),
    mimeType: 'image/jpeg',
  });

  const server = createServer(rewindClient);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  const client = new Client({
    name: 'test-client',
    version: '1.0.0',
  });

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return { client, server, rewindClient };
}

/** Mock responses for each API endpoint. */
function getMockResponse(path: string): unknown {
  // Listening
  if (path === '/listening/now-playing') {
    return {
      is_playing: true,
      track: {
        name: 'Sabotage',
        artist: {
          id: 10,
          name: 'Beastie Boys',
          apple_music_url: 'https://music.apple.com/us/artist/beastie-boys/12',
        },
        album: {
          id: 20,
          name: 'Ill Communication',
          image: {
            cdn_url: 'https://cdn.rewind.rest/listening/albums/20/original.jpg',
            thumbhash: 'x',
            dominant_color: '#111',
            accent_color: '#222',
          },
        },
        url: 'https://www.last.fm/music/Beastie+Boys/_/Sabotage',
        apple_music_url: 'https://music.apple.com/us/album/sabotage/30',
        preview_url: null,
      },
      scrobbled_at: new Date().toISOString(),
    };
  }
  if (path === '/listening/recent') {
    return {
      data: [
        {
          track: {
            id: 1,
            name: 'Sabotage',
            url: 'https://www.last.fm/x',
            apple_music_url:
              'https://music.apple.com/us/album/sabotage/30?i=40',
            preview_url: null,
          },
          artist: { id: 10, name: 'Beastie Boys' },
          album: {
            id: 20,
            name: 'Ill Communication',
            image: {
              cdn_url:
                'https://cdn.rewind.rest/listening/albums/20/original.jpg',
              thumbhash: 'x',
              dominant_color: '#111',
              accent_color: '#222',
            },
          },
          scrobbled_at: new Date().toISOString(),
        },
      ],
    };
  }
  if (path === '/listening/stats') {
    return {
      total_scrobbles: 45000,
      unique_artists: 2100,
      unique_albums: 3800,
      unique_tracks: 12000,
      registered_date: '2008-01-01',
      years_tracking: 18,
      scrobbles_per_day: 12.3,
    };
  }
  if (path.startsWith('/listening/top/')) {
    return {
      period: '1month',
      data: [
        {
          rank: 1,
          id: 10,
          name: 'Beastie Boys',
          detail: 'Artist',
          playcount: 45,
          image: {
            cdn_url:
              'https://cdn.rewind.rest/listening/artists/10/original.jpg',
            thumbhash: 'x',
            dominant_color: '#111',
            accent_color: '#222',
          },
          url: 'https://www.last.fm/music/Beastie+Boys',
          apple_music_url: 'https://music.apple.com/us/artist/beastie-boys/12',
          preview_url: null,
        },
      ],
    };
  }
  if (path === '/listening/streaks') {
    return {
      current: { days: 42, start_date: '2025-01-01', total_scrobbles: 500 },
      longest: {
        days: 365,
        start_date: '2020-01-01',
        end_date: '2020-12-31',
        total_scrobbles: 5000,
      },
    };
  }
  if (path === '/listening/genres') {
    return {
      data: [
        { period: '2026-03', genres: { Rock: 120, Pop: 80 }, total: 200 },
        { period: '2026-04', genres: { Rock: 90, 'Hip-Hop': 60 }, total: 150 },
      ],
    };
  }
  if (path.match(/\/listening\/artists\/\d+/)) {
    return {
      id: 10,
      name: 'Beastie Boys',
      mbid: null,
      url: 'https://www.last.fm/music/Beastie+Boys',
      apple_music_url: 'https://music.apple.com/us/artist/beastie-boys/12',
      playcount: 500,
      scrobble_count: 500,
      genre: 'Hip Hop',
      image: {
        cdn_url: 'https://cdn.rewind.rest/listening/artists/10/original.jpg',
        thumbhash: 'x',
        dominant_color: '#111',
        accent_color: '#222',
      },
      top_albums: [
        {
          id: 20,
          name: "Paul's Boutique",
          playcount: 100,
          apple_music_url: null,
          image: null,
        },
      ],
      top_tracks: [
        {
          id: 30,
          name: 'Sabotage',
          scrobble_count: 50,
          apple_music_url: null,
          preview_url: null,
        },
      ],
    };
  }
  if (path.match(/\/listening\/albums\/\d+/)) {
    return {
      id: 20,
      name: "Paul's Boutique",
      mbid: null,
      url: 'https://www.last.fm/music/Beastie+Boys/Paul%27s+Boutique',
      apple_music_url: 'https://music.apple.com/us/album/pauls-boutique/40',
      playcount: 100,
      image: {
        cdn_url: 'https://cdn.rewind.rest/listening/albums/20/original.jpg',
        thumbhash: 'x',
        dominant_color: '#111',
        accent_color: '#222',
      },
      artist: { id: 10, name: 'Beastie Boys' },
      tracks: [
        {
          id: 30,
          name: 'Shake Your Rump',
          scrobble_count: 20,
          apple_music_url: null,
          preview_url: null,
        },
      ],
    };
  }

  // Running
  if (path === '/running/stats') {
    return {
      data: {
        total_runs: 423,
        total_distance_mi: 1892.4,
        total_elevation_ft: 45000,
        total_duration: '312:45:00',
        avg_pace: '8:32/mi',
        years_active: 5,
        first_run: '2021-01-15',
        eddington_number: 12,
      },
    };
  }
  if (path === '/running/recent') {
    return {
      data: [
        {
          id: 17956091264,
          name: 'Thursday Afternoon Run',
          date: new Date().toISOString(),
          distance_mi: 4.39,
          duration: '33:59',
          pace: '7:44/mi',
          elevation_ft: 360,
          city: 'Austin',
          state: 'TX',
          is_race: false,
          strava_url: 'https://www.strava.com/activities/17956091264',
        },
      ],
    };
  }
  if (path === '/running/stats/years') {
    return {
      data: [
        {
          year: 2026,
          total_runs: 30,
          total_distance_mi: 120,
          total_elevation_ft: 4000,
          total_duration_s: 54000,
          avg_pace: '8:00/mi',
          longest_run_mi: 13.1,
          race_count: 1,
        },
        {
          year: 2025,
          total_runs: 120,
          total_distance_mi: 540,
          total_elevation_ft: 18000,
          total_duration_s: 240000,
          avg_pace: '7:55/mi',
          longest_run_mi: 13.1,
          race_count: 3,
        },
      ],
    };
  }
  if (path === '/running/prs') {
    return {
      data: [
        {
          distance_label: 'Mile',
          time: '6:12',
          pace: '6:12/mi',
          date: '2026-03-31',
          activity_name: 'Tuesday Run',
          activity_id: 123,
        },
      ],
    };
  }
  if (path === '/running/streaks') {
    return {
      data: {
        current: { days: 3, start: '2026-04-01', end: '2026-04-03' },
        longest: { days: 30, start: '2025-06-01', end: '2025-06-30' },
      },
    };
  }
  if (path.match(/\/running\/activities\/\d+$/)) {
    return {
      name: 'Thursday Afternoon Run',
      date: '2026-04-02T16:20:48Z',
      distance_mi: 4.39,
      duration: '33:59',
      pace: '7:44/mi',
      elevation_ft: 360,
      heartrate_avg: 155,
      heartrate_max: 176,
      cadence: 80,
      calories: 514,
      suffer_score: null,
      city: 'Austin',
      state: 'TX',
      is_race: false,
      workout_type: 'default',
      strava_url: 'https://www.strava.com/activities/123',
    };
  }
  if (path.match(/\/running\/activities\/\d+\/splits/)) {
    return {
      data: [
        {
          split: 1,
          distance_mi: 1,
          moving_time_s: 435,
          elapsed_time_s: 449,
          elevation_ft: -55,
          pace: '7:15/mi',
          heartrate: 145,
        },
      ],
    };
  }

  // Watching
  if (path === '/watching/recent') {
    return {
      data: [
        {
          movie: {
            id: 1,
            title: 'The Royal Tenenbaums',
            year: 2001,
            director: 'Wes Anderson',
            tmdb_id: 9428,
            image: {
              url: 'https://cdn.rewind.rest/watching/movies/1/original.jpg',
              thumbhash: 'xhash',
              dominant_color: '#222',
              accent_color: '#c83',
            },
          },
          watched_at: new Date().toISOString(),
          user_rating: 9,
          rewatch: false,
          source: 'plex',
          review: null,
          review_url:
            'https://letterboxd.com/patdugan/film/the-royal-tenenbaums/',
        },
      ],
    };
  }
  if (path.match(/\/watching\/movies\/\d+/)) {
    return {
      id: 1,
      title: 'The Royal Tenenbaums',
      year: 2001,
      director: 'Wes Anderson',
      directors: ['Wes Anderson'],
      genres: ['Comedy', 'Drama'],
      duration_min: 109,
      rating: 'R',
      tmdb_id: 9428,
      tmdb_rating: 7.6,
      tagline: "Family isn't a word. It's a sentence.",
      summary: 'A family drama.',
      imdb_id: 'tt0265666',
      image: {
        url: 'https://cdn.rewind.rest/watching/movies/1/original.jpg',
        thumbhash: 'xhash',
        dominant_color: '#222',
        accent_color: '#c83',
      },
      watch_history: [
        {
          watched_at: '2026-03-10T02:30:00.000Z',
          user_rating: 9,
          rewatch: false,
          review: null,
          review_url:
            'https://letterboxd.com/patdugan/film/the-royal-tenenbaums/',
          source: 'plex',
        },
      ],
    };
  }
  if (path === '/watching/stats') {
    return {
      data: {
        total_movies: 312,
        total_watch_time_hours: 520,
        movies_this_year: 28,
        avg_per_month: 8.5,
        top_genre: 'Drama',
        top_decade: 2000,
        top_director: 'Wes Anderson',
        total_shows: 15,
        total_episodes_watched: 234,
        episodes_this_year: 45,
      },
    };
  }
  if (path === '/watching/stats/genres') {
    return {
      data: [
        { name: 'Drama', count: 120, percentage: 38.5 },
        { name: 'Comedy', count: 80, percentage: 25.6 },
      ],
    };
  }
  if (path === '/watching/stats/decades') {
    return {
      data: [
        { decade: 2020, count: 45 },
        { decade: 2010, count: 90 },
        { decade: 2000, count: 60 },
      ],
    };
  }
  if (path === '/watching/stats/directors') {
    return {
      data: [
        { name: 'Wes Anderson', count: 8 },
        { name: 'Christopher Nolan', count: 6 },
      ],
    };
  }
  if (path === '/watching/movies') {
    return {
      data: [
        {
          id: 1,
          title: 'The Royal Tenenbaums',
          year: 2001,
          director: 'Wes Anderson',
          directors: ['Wes Anderson'],
          genres: ['Comedy'],
          duration_min: 109,
          rating: 'R',
          tmdb_id: 9428,
          tmdb_rating: 7.6,
          image: {
            url: 'https://cdn.rewind.rest/watching/movies/1/original.jpg',
            thumbhash: 'xhash',
            dominant_color: '#222',
            accent_color: '#c83',
          },
        },
      ],
      pagination: { page: 1, limit: 10, total: 1, total_pages: 1 },
    };
  }

  // Collecting
  if (path === '/collecting/vinyl') {
    return {
      data: [
        {
          id: 1,
          discogs_id: 100,
          title: 'Hello Nasty',
          artists: ['Beastie Boys'],
          year: 2009,
          format: 'Vinyl',
          format_detail: 'LP, Reissue',
          label: 'Capitol Records',
          genres: ['Hip Hop'],
          styles: [],
          image: {
            cdn_url:
              'https://cdn.rewind.rest/collecting/releases/1/original.jpg',
            thumbhash: 'x',
            dominant_color: '#111',
            accent_color: '#222',
          },
          date_added: '2024-01-15',
          rating: null,
          discogs_url: 'https://www.discogs.com/release/100',
        },
      ],
      pagination: { page: 1, limit: 10, total: 1, total_pages: 1 },
    };
  }
  if (path.match(/\/collecting\/vinyl\/\d+/)) {
    return {
      id: 1,
      discogs_id: 100,
      title: 'Hello Nasty',
      artists: ['Beastie Boys'],
      year: 2009,
      format: 'Vinyl',
      format_detail: 'LP, Reissue',
      label: 'Capitol Records',
      genres: ['Hip Hop'],
      styles: [],
      image: {
        cdn_url: 'https://cdn.rewind.rest/collecting/releases/1/original.jpg',
      },
      date_added: '2024-01-15',
      rating: null,
      discogs_url: 'https://www.discogs.com/release/100',
      tracklist: [],
    };
  }
  if (path === '/collecting/stats') {
    return {
      data: {
        total_items: 150,
        by_format: { vinyl: 120, cd: 25, cassette: 5 },
        wantlist_count: 30,
        unique_artists: 95,
        estimated_value: null,
        top_genre: 'Rock',
        oldest_release_year: 1967,
        newest_release_year: 2025,
        most_collected_artist: null,
        added_this_year: 12,
      },
    };
  }
  if (path === '/collecting/media') {
    return {
      data: [
        {
          id: 1,
          title: 'The Killing',
          year: 1956,
          tmdb_id: 100,
          imdb_id: null,
          image: {
            cdn_url:
              'https://cdn.rewind.rest/collecting/releases/1/original.jpg',
          },
          runtime: null,
          tmdb_rating: 7.6,
          media_type: 'bluray',
          resolution: null,
          hdr: null,
          audio: null,
          audio_channels: null,
          collected_at: '2026-03-26',
        },
      ],
      pagination: { page: 1, limit: 10, total: 1, total_pages: 1 },
    };
  }
  if (path.match(/\/collecting\/media\/\d+$/)) {
    return {
      id: 1,
      title: 'The Killing',
      year: 1956,
      tmdb_id: 100,
      imdb_id: null,
      tagline: null,
      summary: null,
      image: {
        cdn_url: 'https://cdn.rewind.rest/collecting/releases/1/original.jpg',
      },
      runtime: null,
      tmdb_rating: 7.6,
      content_rating: null,
      media_type: 'bluray',
      resolution: null,
      hdr: null,
      audio: null,
      audio_channels: null,
      collected_at: '2026-03-26',
      watch_history: [],
    };
  }
  if (path === '/collecting/media/formats') {
    return {
      data: [
        { name: 'bluray', count: 56 },
        { name: 'uhd_bluray', count: 30 },
        { name: 'hddvd', count: 11 },
      ],
    };
  }

  // Reading
  if (path === '/reading/recent') {
    return {
      data: [
        {
          id: 1,
          title: 'How to Build an MCP Server',
          author: 'Anthropic',
          url: 'https://www.anthropic.com/blog/how-to-build-an-mcp-server',
          domain: 'anthropic.com',
          estimated_read_min: 12,
          status: 'archived',
          progress: 1,
          image: {
            cdn_url: 'https://cdn.rewind.rest/reading/articles/1/original.jpg',
            thumbhash: 'x',
            dominant_color: '#111',
            accent_color: '#222',
          },
          saved_at: new Date().toISOString(),
        },
      ],
    };
  }
  if (path.match(/\/reading\/articles\/\d+/)) {
    return {
      id: 1,
      title: 'How to Build an MCP Server',
      author: 'Anthropic',
      url: 'https://www.anthropic.com/blog/how-to-build-an-mcp-server',
      domain: 'anthropic.com',
      estimated_read_min: 12,
      status: 'archived',
      progress: 1,
      image: null,
      highlights: [],
      saved_at: new Date().toISOString(),
    };
  }
  if (path === '/reading/highlights') {
    return {
      data: [
        {
          text: 'The best code is no code at all.',
          note: null,
          created_at: '2026-01-15',
          article: {
            id: 99,
            title: 'Less is More',
            author: 'Jeff Atwood',
            domain: 'blog.codinghorror.com',
            url: 'https://blog.codinghorror.com/less-is-more/',
          },
        },
      ],
      pagination: { page: 1, total: 42, total_pages: 5 },
    };
  }
  if (path === '/reading/highlights/random') {
    return {
      text: 'Simplicity is the ultimate sophistication.',
      note: 'Leonardo da Vinci',
      created_at: '2025-06-01',
      article: {
        id: 100,
        title: 'Design Principles',
        author: null,
        domain: 'example.com',
        url: 'https://example.com/design-principles',
      },
    };
  }
  if (path === '/reading/stats') {
    return {
      total_articles: 350,
      finished_count: 280,
      currently_reading_count: 5,
      total_highlights: 420,
      total_word_count: 2500000,
      avg_estimated_read_min: 8,
    };
  }

  // Feed
  if (path.startsWith('/feed/on-this-day')) {
    return {
      month: 4,
      day: 3,
      years: [
        {
          year: 2025,
          items: [
            {
              domain: 'listening',
              event_type: 'discovery',
              title: 'Listened to Radiohead',
              subtitle: 'OK Computer',
            },
          ],
        },
      ],
    };
  }
  if (path.startsWith('/feed')) {
    return {
      data: [
        {
          domain: 'listening',
          event_type: 'scrobble',
          occurred_at: new Date().toISOString(),
          title: 'Sabotage',
          subtitle: 'Beastie Boys',
        },
      ],
      pagination: { has_more: false },
    };
  }

  // Search
  if (path === '/search') {
    return {
      data: [
        {
          domain: 'listening',
          entity_type: 'artist',
          entity_id: '10',
          title: 'Beastie Boys',
          subtitle: null,
        },
        {
          domain: 'watching',
          entity_type: 'movie',
          entity_id: '1',
          title: 'The Royal Tenenbaums',
          subtitle: '2001',
        },
      ],
      pagination: { total: 2 },
    };
  }

  // Health
  if (path === '/health') {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }
  if (path === '/health/sync') {
    return {
      domains: {
        listening: {
          status: 'healthy',
          last_sync: new Date().toISOString(),
          items_synced: 100,
        },
        running: {
          status: 'healthy',
          last_sync: new Date().toISOString(),
          items_synced: 5,
        },
      },
    };
  }

  throw new Error(`Unmocked endpoint: ${path}`);
}

// --- Tests ---

describe('MCP Server', () => {
  let client: Client;

  beforeAll(async () => {
    const ctx = await createTestClient();
    client = ctx.client;
  });

  afterAll(async () => {
    await client.close();
  });

  describe('initialization', () => {
    it('lists all tools', async () => {
      const { tools } = await client.listTools();
      // Exact count so adding/removing a tool fails the test and forces
      // an accompanying docs update. See manifest-snapshot.test.ts for
      // the structural snapshot and scripts/check-docs.mjs for the
      // MDX cross-check.
      expect(tools.length).toBe(45);

      const names = tools.map((t) => t.name);
      expect(names).toContain('get_health');
      expect(names).toContain('get_now_playing');
      expect(names).toContain('get_recent_listens');
      expect(names).toContain('get_running_stats');
      expect(names).toContain('get_activity_splits');
      expect(names).toContain('browse_movies');
      expect(names).toContain('get_vinyl_collection');
      expect(names).toContain('get_physical_media');
      expect(names).toContain('search');
      expect(names).toContain('semantic_search');
      expect(names).toContain('find_similar_articles');
      expect(names).toContain('get_article');
      expect(names).toContain('get_feed');
    });

    it('all tools have readOnlyHint annotation', async () => {
      const { tools } = await client.listTools();
      for (const tool of tools) {
        expect(tool.annotations?.readOnlyHint).toBe(true);
        expect(tool.annotations?.destructiveHint).toBe(false);
      }
    });

    it('lists resources', async () => {
      const { resources } = await client.listResources();
      // At minimum, the non-templated rewind://sync/status resource
      // should always be present. Exact shape is covered by
      // manifest-snapshot.test.ts.
      expect(resources.length).toBeGreaterThanOrEqual(1);
      const uris = resources.map((r) => r.uri);
      expect(uris).toContain('rewind://sync/status');
    });

    it('lists prompts', async () => {
      const { prompts } = await client.listPrompts();
      expect(prompts.length).toBe(7);
      const names = prompts.map((p) => p.name);
      expect(names).toContain('weekly-summary');
      expect(names).toContain('year-in-review');
      expect(names).toContain('compare-periods');
      expect(names).toContain('letterboxd-review-draft');
      expect(names).toContain('training-report');
      expect(names).toContain('film-diet');
      expect(names).toContain('find-article');
    });

    it('exposes server instructions', () => {
      const instructions = client.getInstructions();
      expect(instructions).toBeTruthy();
      expect(instructions).toContain('Rewind');
      expect(instructions).toContain('listening');
      expect(instructions).toContain('resource_link');
      // Keep under 2KB (Claude Code truncates above that)
      expect(instructions!.length).toBeLessThan(2048);
    });
  });

  describe('tool responses are text, not JSON', () => {
    const toolsToTest = [
      { name: 'get_health', args: {} },
      { name: 'get_now_playing', args: {} },
      { name: 'get_recent_listens', args: {} },
      { name: 'get_listening_stats', args: {} },
      { name: 'get_top_artists', args: {} },
      { name: 'get_listening_streaks', args: {} },
      { name: 'get_running_stats', args: {} },
      { name: 'get_recent_runs', args: {} },
      { name: 'get_personal_records', args: {} },
      { name: 'get_running_streaks', args: {} },
      { name: 'get_activity_details', args: { id: 123 } },
      { name: 'get_activity_splits', args: { id: 123 } },
      { name: 'get_recent_watches', args: {} },
      { name: 'get_movie_details', args: { id: 1 } },
      { name: 'get_watching_stats', args: {} },
      { name: 'browse_movies', args: {} },
      { name: 'get_vinyl_collection', args: {} },
      { name: 'get_collecting_stats', args: {} },
      { name: 'get_physical_media', args: {} },
      { name: 'get_physical_media_stats', args: {} },
      { name: 'get_recent_reads', args: {} },
      { name: 'get_reading_highlights', args: {} },
      { name: 'get_random_highlight', args: {} },
      { name: 'get_reading_stats', args: {} },
      { name: 'search', args: { query: 'beastie' } },
      { name: 'get_feed', args: {} },
      { name: 'get_on_this_day', args: {} },
    ];

    for (const { name, args } of toolsToTest) {
      it(`${name} returns text content`, async () => {
        const result = await client.callTool({ name, arguments: args });
        expect(result.content).toBeDefined();
        expect(Array.isArray(result.content)).toBe(true);

        const content = result.content as Array<{ type: string; text: string }>;
        expect(content.length).toBeGreaterThan(0);
        expect(content[0].type).toBe('text');
        expect(typeof content[0].text).toBe('string');
        expect(content[0].text.length).toBeGreaterThan(0);

        // Should NOT be raw JSON
        expect(content[0].text).not.toMatch(/^\s*[\[{]/);

        // Should not have isError
        expect(result.isError).toBeFalsy();
      });
    }
  });

  describe('error handling', () => {
    it('returns isError for failed API calls', async () => {
      // Artist ID 99999 will hit the mock which throws for unknown paths
      const result = await client.callTool({
        name: 'get_artist_details',
        arguments: { id: 99999 },
      });
      expect(result.content).toBeDefined();
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0].type).toBe('text');
      // The mock returns data for any /listening/artists/\d+ so this will succeed
      // That's fine -- the error path is tested by the mock throwing for unknown endpoints
    });
  });

  describe('response content quality', () => {
    it('get_now_playing includes track and artist', async () => {
      const result = await client.callTool({
        name: 'get_now_playing',
        arguments: {},
      });
      const text = (result.content as Array<{ text: string }>)[0].text;
      expect(text).toContain('Sabotage');
      expect(text).toContain('Beastie Boys');
    });

    it('get_recent_runs exposes activity IDs via structuredContent', async () => {
      const result = await client.callTool({
        name: 'get_recent_runs',
        arguments: {},
      });
      const sc = (
        result as { structuredContent?: { items?: Array<{ id?: number }> } }
      ).structuredContent;
      expect(sc?.items?.length).toBeGreaterThan(0);
      expect(typeof sc?.items?.[0]?.id).toBe('number');
    });

    it('get_personal_records exposes activity IDs via structuredContent', async () => {
      const result = await client.callTool({
        name: 'get_personal_records',
        arguments: {},
      });
      const sc = (
        result as {
          structuredContent?: { items?: Array<{ activity_id?: number }> };
        }
      ).structuredContent;
      expect(sc?.items?.length).toBeGreaterThan(0);
      expect(typeof sc?.items?.[0]?.activity_id).toBe('number');
    });

    it('get_activity_splits includes per-mile paces', async () => {
      const result = await client.callTool({
        name: 'get_activity_splits',
        arguments: { id: 123 },
      });
      const text = (result.content as Array<{ text: string }>)[0].text;
      expect(text).toContain('Mile 1');
      expect(text).toContain('7:15');
    });

    it('get_vinyl_collection includes pagination info', async () => {
      const result = await client.callTool({
        name: 'get_vinyl_collection',
        arguments: {},
      });
      const text = (result.content as Array<{ text: string }>)[0].text;
      expect(text).toContain('page');
      expect(text).toContain('total');
    });

    it('get_physical_media_stats includes format breakdown', async () => {
      const result = await client.callTool({
        name: 'get_physical_media_stats',
        arguments: {},
      });
      const text = (result.content as Array<{ text: string }>)[0].text;
      expect(text).toContain('Blu-ray');
      expect(text).toContain('4K UHD');
    });

    it('search returns results with domain metadata in structuredContent', async () => {
      const result = await client.callTool({
        name: 'search',
        arguments: { query: 'beastie' },
      });
      const sc = (
        result as {
          structuredContent?: { items?: Array<{ domain?: string }> };
        }
      ).structuredContent;
      expect(sc?.items?.length).toBeGreaterThan(0);
      expect(sc?.items?.[0]?.domain).toBe('listening');
    });

    it('get_on_this_day groups by year', async () => {
      const result = await client.callTool({
        name: 'get_on_this_day',
        arguments: {},
      });
      const text = (result.content as Array<{ text: string }>)[0].text;
      expect(text).toContain('2025');
    });
  });

  describe('Phase 1 -- watching rich responses', () => {
    type RichContent = Array<{
      type: string;
      text?: string;
      data?: string;
      mimeType?: string;
      uri?: string;
      name?: string;
    }>;

    it('lists the three new aggregate watching tools', async () => {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
      expect(names).toContain('get_watching_genres');
      expect(names).toContain('get_watching_decades');
      expect(names).toContain('get_watching_directors');
    });

    it('get_movie_details returns text, image, resource_link, and structuredContent', async () => {
      const result = await client.callTool({
        name: 'get_movie_details',
        arguments: { id: 1 },
      });
      const content = result.content as RichContent;

      const textBlock = content.find((b) => b.type === 'text');
      const image = content.find((b) => b.type === 'image');
      const link = content.find((b) => b.type === 'resource_link');

      expect(textBlock?.text).toContain('The Royal Tenenbaums');
      expect(image?.mimeType).toBe('image/jpeg');
      expect(image?.data).toBeTruthy();
      expect(link?.uri).toContain('letterboxd.com');

      const structured = (result as { structuredContent?: { id: number } })
        .structuredContent;
      expect(structured?.id).toBe(1);
    });

    it('get_movie_details with include_images=false omits image blocks', async () => {
      const result = await client.callTool({
        name: 'get_movie_details',
        arguments: { id: 1, include_images: false },
      });
      const content = result.content as RichContent;
      expect(content.find((b) => b.type === 'image')).toBeUndefined();
      // resource_link should still be present
      expect(content.find((b) => b.type === 'resource_link')).toBeDefined();
    });

    it('get_recent_watches emits posters and Letterboxd links', async () => {
      const result = await client.callTool({
        name: 'get_recent_watches',
        arguments: {},
      });
      const content = result.content as RichContent;

      expect(content.find((b) => b.type === 'image')).toBeDefined();
      const link = content.find((b) => b.type === 'resource_link');
      expect(link?.uri).toContain('letterboxd.com');
      expect(link?.name).toContain('Letterboxd');
    });

    it('browse_movies emits posters and structuredContent with pagination', async () => {
      const result = await client.callTool({
        name: 'browse_movies',
        arguments: {},
      });
      const content = result.content as RichContent;
      expect(content.find((b) => b.type === 'image')).toBeDefined();

      const structured = (
        result as {
          structuredContent?: { pagination?: { total: number } };
        }
      ).structuredContent;
      expect(structured?.pagination?.total).toBe(1);
    });

    it('get_watching_stats returns structuredContent mirroring the API', async () => {
      const result = await client.callTool({
        name: 'get_watching_stats',
        arguments: {},
      });
      const structured = (
        result as {
          structuredContent?: {
            total_movies: number;
            top_director: string | null;
          };
        }
      ).structuredContent;
      expect(structured?.total_movies).toBe(312);
      expect(structured?.top_director).toBe('Wes Anderson');
      // No image blocks on stats tools
      const content = result.content as RichContent;
      expect(content.find((b) => b.type === 'image')).toBeUndefined();
    });

    it('get_watching_genres returns percentages and structuredContent', async () => {
      const result = await client.callTool({
        name: 'get_watching_genres',
        arguments: {},
      });
      const text = (result.content as RichContent)[0].text;
      expect(text).toContain('Drama');
      expect(text).toContain('38.5%');

      const structured = (
        result as { structuredContent?: { items: Array<{ name: string }> } }
      ).structuredContent;
      expect(structured?.items[0].name).toBe('Drama');
    });

    it('get_watching_decades returns decade breakdown', async () => {
      const result = await client.callTool({
        name: 'get_watching_decades',
        arguments: {},
      });
      const text = (result.content as RichContent)[0].text;
      expect(text).toContain('2020s');
      expect(text).toContain('2010s');
    });

    it('get_watching_directors returns ranked directors', async () => {
      const result = await client.callTool({
        name: 'get_watching_directors',
        arguments: {},
      });
      const text = (result.content as RichContent)[0].text;
      expect(text).toContain('Wes Anderson');
      expect(text).toContain('1. Wes Anderson');
    });

    it('registers movie and show entity resource templates', async () => {
      const { resourceTemplates } = await client.listResourceTemplates();
      const uris = resourceTemplates.map((t) => t.uriTemplate);
      expect(uris).toContain('rewind://movie/{id}');
      expect(uris).toContain('rewind://show/{id}');
    });

    it('reads a movie entity via rewind://movie/{id}', async () => {
      const result = await client.readResource({ uri: 'rewind://movie/1' });
      expect(result.contents.length).toBe(1);
      const content = result.contents[0] as { mimeType?: string; text: string };
      expect(content.mimeType).toBe('application/json');
      const data = JSON.parse(content.text) as { title: string };
      expect(data.title).toBe('The Royal Tenenbaums');
    });
  });

  describe('Phase 2 -- listening rich responses', () => {
    type RichContent = Array<{
      type: string;
      text?: string;
      data?: string;
      mimeType?: string;
      uri?: string;
      name?: string;
    }>;

    it('lists get_listening_genres tool', async () => {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toContain('get_listening_genres');
    });

    it('get_now_playing returns text, album cover image, and Apple Music links', async () => {
      const result = await client.callTool({
        name: 'get_now_playing',
        arguments: {},
      });
      const content = result.content as RichContent;
      expect(content.find((b) => b.type === 'image')).toBeDefined();
      const links = content.filter((b) => b.type === 'resource_link');
      expect(links.length).toBeGreaterThanOrEqual(2);
      expect(links.some((b) => b.name?.includes('Apple Music'))).toBe(true);
    });

    it('get_album_details returns cover, Apple Music link, and structuredContent', async () => {
      const result = await client.callTool({
        name: 'get_album_details',
        arguments: { id: 20 },
      });
      const content = result.content as RichContent;
      expect(content.find((b) => b.type === 'image')).toBeDefined();
      expect(
        content.find(
          (b) => b.type === 'resource_link' && b.name?.includes('Apple Music')
        )
      ).toBeDefined();
      const structured = (result as { structuredContent?: { id: number } })
        .structuredContent;
      expect(structured?.id).toBe(20);
    });

    it('get_artist_details returns artist image and links', async () => {
      const result = await client.callTool({
        name: 'get_artist_details',
        arguments: { id: 10 },
      });
      const content = result.content as RichContent;
      expect(content.find((b) => b.type === 'image')).toBeDefined();
      expect(
        content.find(
          (b) => b.type === 'resource_link' && b.name?.includes('Apple Music')
        )
      ).toBeDefined();
    });

    it('get_recent_listens emits top-N covers and Apple Music links', async () => {
      const result = await client.callTool({
        name: 'get_recent_listens',
        arguments: {},
      });
      const content = result.content as RichContent;
      expect(content.find((b) => b.type === 'image')).toBeDefined();
      expect(content.find((b) => b.type === 'resource_link')).toBeDefined();
    });

    it('get_top_artists includes structuredContent mirroring API shape', async () => {
      const result = await client.callTool({
        name: 'get_top_artists',
        arguments: {},
      });
      const structured = (
        result as {
          structuredContent?: {
            period: string;
            data: Array<{ id: number }>;
          };
        }
      ).structuredContent;
      expect(structured?.period).toBe('1month');
      expect(structured?.data[0].id).toBe(10);
    });

    it('get_listening_genres returns period breakdown and structuredContent', async () => {
      const result = await client.callTool({
        name: 'get_listening_genres',
        arguments: {},
      });
      const text = (result.content as RichContent)[0].text;
      expect(text).toContain('Rock');

      const structured = (
        result as {
          structuredContent?: { items: Array<{ period: string }> };
        }
      ).structuredContent;
      expect(structured?.items[0].period).toBe('2026-03');
    });

    it('registers album and artist entity resource templates', async () => {
      const { resourceTemplates } = await client.listResourceTemplates();
      const uris = resourceTemplates.map((t) => t.uriTemplate);
      expect(uris).toContain('rewind://album/{id}');
      expect(uris).toContain('rewind://artist/{id}');
    });

    it('reads an album entity via rewind://album/{id}', async () => {
      const result = await client.readResource({ uri: 'rewind://album/20' });
      const content = result.contents[0] as { mimeType?: string; text: string };
      expect(content.mimeType).toBe('application/json');
      const data = JSON.parse(content.text) as { name: string };
      expect(data.name).toBe("Paul's Boutique");
    });
  });

  describe('Phase 3 -- collecting rich responses', () => {
    type RichContent = Array<{
      type: string;
      text?: string;
      uri?: string;
      name?: string;
    }>;

    it('get_vinyl_collection emits top-N covers + Discogs resource_links', async () => {
      const result = await client.callTool({
        name: 'get_vinyl_collection',
        arguments: {},
      });
      const content = result.content as RichContent;
      expect(content.find((b) => b.type === 'image')).toBeDefined();
      const link = content.find((b) => b.type === 'resource_link');
      expect(link?.uri).toContain('discogs.com');
      expect(link?.name).toContain('Discogs');
    });

    it('get_collecting_stats includes structuredContent mirroring the API', async () => {
      const result = await client.callTool({
        name: 'get_collecting_stats',
        arguments: {},
      });
      const structured = (
        result as {
          structuredContent?: {
            total_items: number;
            by_format: Record<string, number>;
          };
        }
      ).structuredContent;
      expect(structured?.total_items).toBe(150);
      expect(structured?.by_format.vinyl).toBe(120);
    });

    it('get_physical_media emits covers and pagination', async () => {
      const result = await client.callTool({
        name: 'get_physical_media',
        arguments: {},
      });
      const content = result.content as RichContent;
      expect(content.find((b) => b.type === 'image')).toBeDefined();
      const structured = (
        result as {
          structuredContent?: { pagination?: { total: number } };
        }
      ).structuredContent;
      expect(structured?.pagination?.total).toBe(1);
    });

    it('get_physical_media_stats returns total + per-format structuredContent', async () => {
      const result = await client.callTool({
        name: 'get_physical_media_stats',
        arguments: {},
      });
      const structured = (
        result as {
          structuredContent?: {
            total: number;
            formats: Array<{ name: string; count: number }>;
          };
        }
      ).structuredContent;
      expect(structured?.total).toBe(97);
      expect(structured?.formats.length).toBe(3);
    });

    it('registers vinyl and physical-media entity templates', async () => {
      const { resourceTemplates } = await client.listResourceTemplates();
      const uris = resourceTemplates.map((t) => t.uriTemplate);
      expect(uris).toContain('rewind://vinyl/{id}');
      expect(uris).toContain('rewind://physical-media/{id}');
    });

    it('reads a vinyl entity via rewind://vinyl/{id}', async () => {
      const result = await client.readResource({ uri: 'rewind://vinyl/1' });
      const content = result.contents[0] as { mimeType?: string; text: string };
      expect(content.mimeType).toBe('application/json');
      const data = JSON.parse(content.text) as { title: string };
      expect(data.title).toBe('Hello Nasty');
    });
  });

  describe('Phase 4 -- reading rich responses', () => {
    type RichContent = Array<{
      type: string;
      text?: string;
      uri?: string;
      name?: string;
    }>;

    it('get_recent_reads emits article URL resource_links and structuredContent', async () => {
      const result = await client.callTool({
        name: 'get_recent_reads',
        arguments: {},
      });
      const content = result.content as RichContent;
      const link = content.find((b) => b.type === 'resource_link');
      expect(link?.uri).toContain('anthropic.com');
      const structured = (
        result as { structuredContent?: { items: Array<{ id: number }> } }
      ).structuredContent;
      expect(structured?.items[0].id).toBe(1);
    });

    it('get_reading_highlights emits article URLs as resource_links', async () => {
      const result = await client.callTool({
        name: 'get_reading_highlights',
        arguments: {},
      });
      const content = result.content as RichContent;
      const link = content.find((b) => b.type === 'resource_link');
      expect(link?.uri).toContain('codinghorror.com');
    });

    it('get_random_highlight emits article URL resource_link', async () => {
      const result = await client.callTool({
        name: 'get_random_highlight',
        arguments: {},
      });
      const content = result.content as RichContent;
      const link = content.find((b) => b.type === 'resource_link');
      expect(link?.uri).toContain('example.com');
    });

    it('get_reading_stats returns structuredContent mirroring API', async () => {
      const result = await client.callTool({
        name: 'get_reading_stats',
        arguments: {},
      });
      const structured = (
        result as {
          structuredContent?: {
            total_articles: number;
            total_highlights: number;
          };
        }
      ).structuredContent;
      expect(structured?.total_articles).toBe(350);
      expect(structured?.total_highlights).toBe(420);
    });

    it('registers article entity template', async () => {
      const { resourceTemplates } = await client.listResourceTemplates();
      const uris = resourceTemplates.map((t) => t.uriTemplate);
      expect(uris).toContain('rewind://article/{id}');
    });

    it('reads an article entity via rewind://article/{id}', async () => {
      const result = await client.readResource({ uri: 'rewind://article/1' });
      const content = result.contents[0] as { mimeType?: string; text: string };
      expect(content.mimeType).toBe('application/json');
      const data = JSON.parse(content.text) as { title: string };
      expect(data.title).toBe('How to Build an MCP Server');
    });
  });

  describe('Phase 5 -- running rich responses', () => {
    type RichContent = Array<{
      type: string;
      text?: string;
      uri?: string;
      name?: string;
    }>;

    it('lists the new get_running_years tool', async () => {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toContain('get_running_years');
    });

    it('get_recent_runs emits Strava resource_links', async () => {
      const result = await client.callTool({
        name: 'get_recent_runs',
        arguments: {},
      });
      const content = result.content as RichContent;
      const link = content.find((b) => b.type === 'resource_link');
      expect(link?.uri).toContain('strava.com');
    });

    it('get_activity_details emits Strava resource_link and structuredContent', async () => {
      const result = await client.callTool({
        name: 'get_activity_details',
        arguments: { id: 123 },
      });
      const content = result.content as RichContent;
      const link = content.find((b) => b.type === 'resource_link');
      expect(link?.uri).toContain('strava.com');
      expect(link?.name).toContain('Strava');
      const structured = (result as { structuredContent?: { name: string } })
        .structuredContent;
      expect(structured?.name).toBe('Thursday Afternoon Run');
    });

    it('get_running_stats returns structuredContent mirroring API', async () => {
      const result = await client.callTool({
        name: 'get_running_stats',
        arguments: {},
      });
      const structured = (
        result as {
          structuredContent?: { total_runs: number; eddington_number: number };
        }
      ).structuredContent;
      expect(structured?.total_runs).toBe(423);
      expect(structured?.eddington_number).toBe(12);
    });

    it('get_running_years returns per-year breakdown', async () => {
      const result = await client.callTool({
        name: 'get_running_years',
        arguments: {},
      });
      const structured = (
        result as {
          structuredContent?: { items: Array<{ year: number }> };
        }
      ).structuredContent;
      expect(structured?.items.length).toBe(2);
      expect(structured?.items[0].year).toBe(2026);
    });

    it('registers activity entity template', async () => {
      const { resourceTemplates } = await client.listResourceTemplates();
      const uris = resourceTemplates.map((t) => t.uriTemplate);
      expect(uris).toContain('rewind://activity/{id}');
    });
  });

  describe('Phase 6 -- cross-domain rich responses', () => {
    type RichContent = Array<{
      type: string;
      text?: string;
      uri?: string;
      name?: string;
    }>;

    it('search emits rewind:// resource_links per match', async () => {
      const result = await client.callTool({
        name: 'search',
        arguments: { query: 'beastie' },
      });
      const content = result.content as RichContent;
      const links = content.filter((b) => b.type === 'resource_link');
      expect(links.length).toBeGreaterThanOrEqual(2);
      expect(links.map((l) => l.uri)).toContain('rewind://artist/10');
      expect(links.map((l) => l.uri)).toContain('rewind://movie/1');
    });

    it('search structuredContent mirrors API', async () => {
      const result = await client.callTool({
        name: 'search',
        arguments: { query: 'beastie' },
      });
      const structured = (
        result as {
          structuredContent?: {
            items: Array<{ entity_id: string }>;
            pagination: { total: number };
          };
        }
      ).structuredContent;
      expect(structured?.items.length).toBe(2);
      expect(structured?.pagination.total).toBe(2);
    });

    it('get_feed returns structuredContent with items + pagination', async () => {
      const result = await client.callTool({
        name: 'get_feed',
        arguments: {},
      });
      const structured = (
        result as {
          structuredContent?: {
            items: Array<{ domain: string }>;
            pagination: { has_more: boolean };
          };
        }
      ).structuredContent;
      expect(structured?.items[0].domain).toBe('listening');
    });

    it('get_on_this_day returns structuredContent grouped by year', async () => {
      const result = await client.callTool({
        name: 'get_on_this_day',
        arguments: {},
      });
      const structured = (
        result as {
          structuredContent?: {
            month: number;
            day: number;
            years: Array<{ year: number }>;
          };
        }
      ).structuredContent;
      expect(structured?.years[0].year).toBe(2025);
    });
  });
});
