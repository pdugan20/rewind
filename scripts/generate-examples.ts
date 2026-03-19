/**
 * Generate OpenAPI response examples for all endpoints.
 *
 * This script defines curated example data and outputs the example objects
 * that need to be added to each route file's response schema.
 *
 * Usage: npx tsx scripts/generate-examples.ts > /tmp/examples.json
 */

// ─── Curated Data ─────────────────────────────────────────────────────

const IMAGE = {
  artist: {
    url: 'https://cdn.rewind.rest/listening/artists/189/original.jpg?width=300&height=300&fit=cover&format=auto&quality=85&v=1',
    thumbhash: 'GggGBwDN+CSBp7VXcmVmlyZ2BgAAAAAA',
    dominant_color: '#191919',
    accent_color: '#7e7e7e',
  },
  album: {
    url: 'https://cdn.rewind.rest/listening/albums/20/original.jpg?width=300&height=300&fit=cover&format=auto&quality=85&v=1',
    thumbhash: 'HBkKHQi694WIeIiAh3Z3d2eAd4B3',
    dominant_color: '#5c4a6d',
    accent_color: '#c4a8d4',
  },
  movie: {
    url: 'https://cdn.rewind.rest/watching/movies/15/original.jpg?width=300&height=300&fit=cover&format=auto&quality=85&v=1',
    thumbhash: 'YRcKDQKadZh4d3Z4d3aHeAeAh4B3',
    dominant_color: '#2a2a2a',
    accent_color: '#c8a882',
  },
  vinyl: {
    url: 'https://cdn.rewind.rest/collecting/releases/1234/original.jpg?width=300&height=300&fit=cover&format=auto&quality=85&v=1',
    thumbhash: 'GncKRwaU9niFd3dShlaJSFeJlYCYhGYA',
    dominant_color: '#222229',
    accent_color: '#9b31ed',
  },
};

const PAGINATION = { page: 1, limit: 20, total: 150, total_pages: 8 };

// All examples keyed by operationId
const examples: Record<string, unknown> = {
  // ─── System ───
  getHealthSync: {
    status: 'ok',
    domains: {
      listening: {
        last_sync: '2026-03-18T21:00:00.000Z',
        status: 'completed',
        sync_type: 'scrobbles',
        items_synced: 42,
        duration_ms: 1250,
        error: null,
        error_rate: 0.0,
      },
      running: {
        last_sync: '2026-03-18T03:00:00.000Z',
        status: 'completed',
        sync_type: 'activities',
        items_synced: 3,
        duration_ms: 4200,
        error: null,
        error_rate: 0.0,
      },
    },
  },

  // ─── Listening ───
  getListeningNowPlaying: {
    is_playing: true,
    track: {
      name: 'Espresso',
      artist: {
        id: 471,
        name: 'Sabrina Carpenter',
        apple_music_url:
          'https://music.apple.com/us/artist/sabrina-carpenter/595947033?uo=4',
      },
      album: { id: 254, name: "Short n' Sweet", image: IMAGE.album },
      url: 'https://www.last.fm/music/Sabrina+Carpenter/_/Espresso',
      apple_music_url:
        'https://music.apple.com/us/album/espresso/1745069032?i=1745069234&uo=4',
      preview_url: null,
    },
    scrobbled_at: '2026-03-18T22:30:00.000Z',
  },

  getListeningRecent: {
    data: [
      {
        track: {
          id: 1001,
          name: 'bad idea right?',
          url: 'https://www.last.fm/music/Olivia+Rodrigo/_/bad+idea+right%3F',
          apple_music_url:
            'https://music.apple.com/us/album/bad-idea-right/1694386825?i=1694386835&uo=4',
          preview_url: null,
        },
        artist: { id: 37, name: 'Olivia Rodrigo' },
        album: { id: 20, name: 'GUTS', image: IMAGE.album },
        scrobbled_at: '2026-03-18T22:14:04.000Z',
      },
      {
        track: {
          id: 1002,
          name: 'Sabotage',
          url: 'https://www.last.fm/music/Beastie+Boys/_/Sabotage',
          apple_music_url: null,
          preview_url: null,
        },
        artist: { id: 130, name: 'Beastie Boys' },
        album: { id: 500, name: 'Ill Communication', image: IMAGE.album },
        scrobbled_at: '2026-03-18T22:10:00.000Z',
      },
      {
        track: {
          id: 1003,
          name: 'Come as You Are',
          url: 'https://www.last.fm/music/Nirvana/_/Come+as+You+Are',
          apple_music_url:
            'https://music.apple.com/us/album/come-as-you-are/1440783617?i=1440783636&uo=4',
          preview_url: null,
        },
        artist: { id: 189, name: 'Nirvana' },
        album: { id: 300, name: 'Nevermind', image: IMAGE.album },
        scrobbled_at: '2026-03-18T22:05:00.000Z',
      },
    ],
  },

  getListeningTopAlbums: {
    period: 'overall',
    data: [
      {
        rank: 1,
        id: 300,
        name: 'MTV Unplugged in New York',
        detail: 'Nirvana',
        playcount: 428,
        image: IMAGE.album,
        url: 'https://www.last.fm/music/Nirvana/MTV+Unplugged+in+New+York',
        apple_music_url: null,
      },
      {
        rank: 2,
        id: 500,
        name: 'Hot Sauce Committee Part Two',
        detail: 'Beastie Boys',
        playcount: 534,
        image: IMAGE.album,
        url: 'https://www.last.fm/music/Beastie+Boys/Hot+Sauce+Committee+Part+Two',
        apple_music_url: null,
      },
      {
        rank: 3,
        id: 20,
        name: 'GUTS',
        detail: 'Olivia Rodrigo',
        playcount: 32,
        image: IMAGE.album,
        url: 'https://www.last.fm/music/Olivia+Rodrigo/GUTS',
        apple_music_url: null,
      },
    ],
    pagination: PAGINATION,
  },

  getListeningTopTracks: {
    period: 'overall',
    data: [
      {
        rank: 1,
        id: 595,
        name: 'Come as You Are',
        detail: 'Nirvana',
        playcount: 101,
        image: null,
        url: 'https://www.last.fm/music/Nirvana/_/Come+as+You+Are',
        apple_music_url:
          'https://music.apple.com/us/album/come-as-you-are/1440783617?i=1440783636&uo=4',
        preview_url: null,
      },
      {
        rank: 2,
        id: 1050,
        name: 'bad idea right?',
        detail: 'Olivia Rodrigo',
        playcount: 82,
        image: null,
        url: 'https://www.last.fm/music/Olivia+Rodrigo/_/bad+idea+right%3F',
        apple_music_url: null,
        preview_url: null,
      },
      {
        rank: 3,
        id: 2001,
        name: 'Espresso',
        detail: 'Sabrina Carpenter',
        playcount: 68,
        image: null,
        url: 'https://www.last.fm/music/Sabrina+Carpenter/_/Espresso',
        apple_music_url: null,
        preview_url: null,
      },
    ],
    pagination: PAGINATION,
  },

  getListeningStats: {
    total_scrobbles: 123867,
    unique_artists: 5278,
    unique_albums: 11168,
    unique_tracks: 28405,
    registered_date: '2012-02-09T16:01:17.000Z',
    years_tracking: 14,
    scrobbles_per_day: 24,
  },

  getListeningHistory: {
    data: [
      {
        track: {
          id: 1001,
          name: 'bad idea right?',
          url: 'https://www.last.fm/music/Olivia+Rodrigo/_/bad+idea+right%3F',
          apple_music_url: null,
          preview_url: null,
        },
        artist: { id: 37, name: 'Olivia Rodrigo' },
        album: { id: 20, name: 'GUTS', image: IMAGE.album },
        scrobbled_at: '2026-03-18T22:14:04.000Z',
      },
    ],
  },

  listListeningArtists: {
    data: [
      {
        id: 130,
        name: 'Beastie Boys',
        playcount: 4011,
        genre: 'Hip-Hop',
        url: 'https://www.last.fm/music/Beastie+Boys',
        apple_music_url: null,
        image: IMAGE.artist,
      },
      {
        id: 189,
        name: 'Nirvana',
        playcount: 2179,
        genre: 'Grunge',
        url: 'https://www.last.fm/music/Nirvana',
        apple_music_url:
          'https://music.apple.com/us/artist/nirvana/112018?uo=4',
        image: IMAGE.artist,
      },
      {
        id: 92,
        name: 'Taylor Swift',
        playcount: 2164,
        genre: 'Country',
        url: 'https://www.last.fm/music/Taylor+Swift',
        apple_music_url:
          'https://music.apple.com/us/artist/taylor-swift/159260351?uo=4',
        image: IMAGE.artist,
      },
    ],
    pagination: PAGINATION,
  },

  listListeningAlbums: {
    data: [
      {
        id: 300,
        name: 'Nevermind',
        artist: 'Nirvana',
        playcount: 333,
        url: 'https://www.last.fm/music/Nirvana/Nevermind',
        apple_music_url: null,
        image: IMAGE.album,
      },
      {
        id: 20,
        name: 'GUTS',
        artist: 'Olivia Rodrigo',
        playcount: 32,
        url: 'https://www.last.fm/music/Olivia+Rodrigo/GUTS',
        apple_music_url: null,
        image: IMAGE.album,
      },
    ],
    pagination: PAGINATION,
  },

  getListeningArtist: {
    id: 189,
    name: 'Nirvana',
    mbid: null,
    url: 'https://www.last.fm/music/Nirvana',
    apple_music_url: 'https://music.apple.com/us/artist/nirvana/112018?uo=4',
    playcount: 2179,
    scrobble_count: 2193,
    first_scrobbled_at: '2012-05-02T18:32:15.000Z',
    genre: 'Grunge',
    tags: [
      { name: 'Grunge', count: 100 },
      { name: 'Rock', count: 49 },
      { name: 'Alternative', count: 26 },
    ],
    image: IMAGE.artist,
    top_albums: [
      {
        id: 300,
        name: 'MTV Unplugged in New York',
        playcount: 428,
        apple_music_url: null,
        image: IMAGE.album,
      },
      {
        id: 301,
        name: 'Nevermind',
        playcount: 333,
        apple_music_url: null,
        image: IMAGE.album,
      },
    ],
    top_tracks: [
      {
        id: 595,
        name: 'Come as You Are',
        scrobble_count: 101,
        apple_music_url:
          'https://music.apple.com/us/album/come-as-you-are/1440783617?i=1440783636&uo=4',
      },
      { id: 596, name: 'Polly', scrobble_count: 84, apple_music_url: null },
    ],
  },

  getListeningAlbum: {
    id: 20,
    name: 'GUTS',
    artist: { id: 37, name: 'Olivia Rodrigo' },
    playcount: 32,
    url: 'https://www.last.fm/music/Olivia+Rodrigo/GUTS',
    apple_music_url: null,
    image: IMAGE.album,
    tracks: [
      { id: 1001, name: 'bad idea right?', scrobble_count: 82 },
      { id: 1002, name: 'vampire', scrobble_count: 57 },
      { id: 1003, name: 'all-american bitch', scrobble_count: 45 },
    ],
  },

  getListeningCalendar: {
    year: 2026,
    days: [
      { date: '2026-03-01', count: 15 },
      { date: '2026-03-02', count: 22 },
      { date: '2026-03-03', count: 8 },
    ],
  },

  getListeningTrends: {
    data: [
      {
        period: '2026-01',
        genres: {
          'Classic Rock': 132,
          'Hip-Hop': 95,
          Alternative: 61,
          Other: 264,
        },
        total: 552,
      },
      {
        period: '2026-02',
        genres: { Pop: 180, 'Hip-Hop': 66, Grunge: 55, Other: 200 },
        total: 501,
      },
    ],
  },

  getListeningStreaks: {
    current: { days: 3, start_date: '2026-03-16', total_scrobbles: 65 },
    longest: {
      days: 62,
      start_date: '2017-01-02',
      end_date: '2017-03-04',
      total_scrobbles: 3535,
    },
  },

  getListeningYearInReview: {
    year: 2025,
    total_scrobbles: 8500,
    unique_artists: 420,
    unique_albums: 890,
    unique_tracks: 3200,
    top_artist: { id: 92, name: 'Taylor Swift', playcount: 350 },
    top_album: {
      id: 20,
      name: 'GUTS',
      artist: 'Olivia Rodrigo',
      playcount: 120,
    },
    top_track: {
      id: 2001,
      name: 'Espresso',
      artist: 'Sabrina Carpenter',
      playcount: 68,
    },
    scrobbles_per_day: 23,
  },

  getListeningGenres: {
    data: [
      { genre: 'Rock', artist_count: 850, playcount: 25000 },
      { genre: 'Hip-Hop', artist_count: 420, playcount: 12000 },
      { genre: 'Pop', artist_count: 380, playcount: 9500 },
    ],
    pagination: PAGINATION,
  },

  // ─── Running ───
  listRunningStatsYears: {
    data: [
      {
        year: 2025,
        total_runs: 120,
        total_distance_mi: 540.2,
        total_elevation_ft: 18500,
        avg_pace: '7:55/mi',
      },
      {
        year: 2024,
        total_runs: 105,
        total_distance_mi: 470.8,
        total_elevation_ft: 15200,
        avg_pace: '8:10/mi',
      },
    ],
  },

  getRunningStatsYear: {
    data: {
      year: 2025,
      total_runs: 120,
      total_distance_mi: 540.2,
      total_elevation_ft: 18500,
      total_duration: '71:30:00',
      avg_pace: '7:55/mi',
      longest_run_mi: 13.1,
      most_elevation_ft: 1250,
    },
  },

  getRunningPRs: {
    data: [
      {
        distance: '5K',
        time: '22:45',
        pace: '7:20/mi',
        date: '2024-09-15',
        activity_id: 12345,
      },
      {
        distance: '10K',
        time: '48:30',
        pace: '7:49/mi',
        date: '2024-06-01',
        activity_id: 12346,
      },
      {
        distance: 'Half Marathon',
        time: '1:45:00',
        pace: '8:01/mi',
        date: '2023-10-08',
        activity_id: 12347,
      },
    ],
  },

  getRunningRecent: {
    data: [
      {
        id: 17748681520,
        strava_id: 17748681520,
        name: 'Monday Evening Run',
        date: '2026-03-16T17:00:05Z',
        distance_mi: 4.49,
        duration: '36:02',
        duration_s: 2162,
        pace: '8:02/mi',
        elevation_ft: 370.73,
        heartrate_avg: null,
        heartrate_max: null,
        cadence: 75.2,
        calories: 525,
        suffer_score: null,
        city: null,
        state: null,
        polyline: '_wfbHb|niVD_@TEd@...',
        is_race: false,
        workout_type: 'default',
        strava_url: 'https://www.strava.com/activities/17748681520',
      },
    ],
  },

  getRunningActivity: {
    data: {
      id: 17748681520,
      strava_id: 17748681520,
      name: 'Monday Evening Run',
      date: '2026-03-16T17:00:05Z',
      distance_mi: 4.49,
      duration: '36:02',
      duration_s: 2162,
      pace: '8:02/mi',
      elevation_ft: 370.73,
      heartrate_avg: null,
      heartrate_max: null,
      cadence: 75.2,
      calories: 525,
      suffer_score: null,
      city: null,
      state: null,
      polyline: '_wfbHb|niVD_@TEd@...',
      is_race: false,
      workout_type: 'default',
      strava_url: 'https://www.strava.com/activities/17748681520',
    },
  },

  getRunningActivitySplits: {
    data: {
      activity_id: 17748681520,
      splits: [
        { mile: 1, time: '8:15', pace: '8:15/mi', elevation_ft: 85 },
        { mile: 2, time: '7:50', pace: '7:50/mi', elevation_ft: 120 },
        { mile: 3, time: '8:02', pace: '8:02/mi', elevation_ft: 95 },
        { mile: 4, time: '7:55', pace: '7:55/mi', elevation_ft: 70 },
      ],
    },
  },

  listRunningGear: {
    data: [
      {
        id: 'g12345',
        name: 'Nike Pegasus 40',
        distance_mi: 342.5,
        retired: false,
      },
      {
        id: 'g12346',
        name: 'Brooks Ghost 15',
        distance_mi: 512.3,
        retired: true,
      },
    ],
  },

  getRunningCalendar: {
    year: 2026,
    days: [
      { date: '2026-03-01', count: 1, distance_mi: 5.2 },
      { date: '2026-03-03', count: 1, distance_mi: 4.1 },
      { date: '2026-03-05', count: 1, distance_mi: 6.8 },
    ],
  },

  getRunningChartsCumulative: {
    data: {
      '2026': [
        { day: 1, cumulative_mi: 5.2 },
        { day: 3, cumulative_mi: 9.3 },
        { day: 5, cumulative_mi: 16.1 },
      ],
      '2025': [
        { day: 2, cumulative_mi: 4.8 },
        { day: 5, cumulative_mi: 12.6 },
      ],
    },
  },

  getRunningChartsPaceTrend: {
    data: [
      { date: '2026-03-01', pace_seconds: 482, distance_mi: 5.2 },
      { date: '2026-03-03', pace_seconds: 495, distance_mi: 4.1 },
    ],
  },

  getRunningChartsTimeOfDay: {
    data: [
      { hour: 6, count: 45 },
      { hour: 7, count: 82 },
      { hour: 17, count: 120 },
      { hour: 18, count: 95 },
    ],
  },

  getRunningChartsElevation: {
    data: [
      { date: '2026-03-01', elevation_ft: 350 },
      { date: '2026-03-03', elevation_ft: 280 },
    ],
  },

  listRunningCities: {
    data: [
      { city: 'Portland', state: 'OR', count: 450, total_distance_mi: 1800 },
      { city: 'Seattle', state: 'WA', count: 120, total_distance_mi: 480 },
    ],
  },

  getRunningStreaks: {
    data: {
      current: { days: 0, start: null, end: null },
      longest: { days: 8, start: '2020-05-09', end: '2020-05-16' },
    },
  },

  listRunningRaces: {
    data: [
      {
        id: 12345,
        strava_id: 12345,
        name: 'Portland Marathon',
        date: '2024-10-06',
        distance_mi: 26.2,
        duration: '3:45:00',
        pace: '8:35/mi',
        strava_url: 'https://www.strava.com/activities/12345',
      },
    ],
  },

  getRunningEddington: {
    data: {
      eddington_number: 11,
      next_target: 12,
      runs_needed: 3,
      history: [
        { distance_mi: 11, count: 11 },
        { distance_mi: 12, count: 9 },
      ],
    },
  },

  getRunningYearInReview: {
    data: {
      year: 2025,
      total_runs: 120,
      total_distance_mi: 540.2,
      total_elevation_ft: 18500,
      total_duration: '71:30:00',
      avg_pace: '7:55/mi',
      longest_run: { id: 12345, distance_mi: 13.1, date: '2025-10-06' },
      monthly_breakdown: [
        { month: 1, runs: 8, distance_mi: 35.2 },
        { month: 2, runs: 10, distance_mi: 42.1 },
      ],
    },
  },

  // ─── Watching ───
  getWatchingMovie: {
    data: {
      id: 15,
      title: "Ferris Bueller's Day Off",
      year: 1986,
      director: 'John Hughes',
      directors: ['John Hughes'],
      genres: ['Comedy'],
      duration_min: 103,
      rating: 'PG-13',
      image: IMAGE.movie,
      imdb_id: 'tt0091042',
      tmdb_id: 9377,
      tmdb_rating: 7.6,
      tagline: "One man's struggle to take it easy.",
      summary:
        'A high school wise guy is determined to have a day off from school, despite what the Principal thinks of that.',
      watch_history: [
        { watched_at: '2026-03-10T02:30:00.000Z', source: 'plex' },
        { watched_at: '2024-12-25T20:00:00.000Z', source: 'plex' },
      ],
    },
  },

  getWatchingStats: {
    data: {
      total_movies: 773,
      total_watch_time_hours: 1507,
      movies_this_year: 27,
      avg_per_month: 8.1,
      top_genre: 'Drama',
      top_decade: 2000,
      top_director: 'Martin Scorsese',
      total_shows: 98,
      total_episodes_watched: 1572,
      episodes_this_year: 106,
    },
  },

  getWatchingStatsGenres: {
    data: [
      { genre: 'Drama', count: 280 },
      { genre: 'Comedy', count: 195 },
      { genre: 'Action', count: 142 },
    ],
  },

  getWatchingStatsDecades: {
    data: [
      { decade: 2020, count: 185 },
      { decade: 2010, count: 210 },
      { decade: 2000, count: 145 },
    ],
  },

  getWatchingStatsDirectors: {
    data: [
      { director: 'Martin Scorsese', count: 18 },
      { director: 'Steven Spielberg', count: 14 },
      { director: 'Christopher Nolan', count: 12 },
    ],
  },

  getWatchingCalendar: {
    year: 2026,
    days: [
      { date: '2026-03-10', count: 1 },
      { date: '2026-03-12', count: 2 },
      { date: '2026-03-14', count: 1 },
    ],
  },

  getWatchingTrends: {
    data: [
      { period: '2026-01', count: 8 },
      { period: '2026-02', count: 10 },
      { period: '2026-03', count: 9 },
    ],
  },

  listWatchingShows: {
    data: [
      {
        id: 1,
        title: 'Band of Brothers',
        year: 2001,
        tmdb_id: 4613,
        tmdb_rating: 8.5,
        content_rating: 'TV-MA',
        summary: 'The story of Easy Company during WWII.',
        image: IMAGE.movie,
        total_seasons: 1,
        total_episodes: 10,
        episodes_watched: 10,
      },
      {
        id: 2,
        title: 'Mad Men',
        year: 2007,
        tmdb_id: 1104,
        tmdb_rating: 8.2,
        content_rating: 'TV-14',
        summary: null,
        image: IMAGE.movie,
        total_seasons: 7,
        total_episodes: 92,
        episodes_watched: 89,
      },
      {
        id: 3,
        title: 'Fallout',
        year: 2024,
        tmdb_id: 106379,
        tmdb_rating: 8.0,
        content_rating: 'TV-MA',
        summary: null,
        image: IMAGE.movie,
        total_seasons: 1,
        total_episodes: 8,
        episodes_watched: 8,
      },
    ],
    pagination: PAGINATION,
  },

  getWatchingShow: {
    data: {
      id: 1,
      title: 'Band of Brothers',
      year: 2001,
      tmdb_id: 4613,
      tmdb_rating: 8.5,
      content_rating: 'TV-MA',
      summary: 'The story of Easy Company during WWII.',
      image: IMAGE.movie,
      total_seasons: 1,
      total_episodes: 10,
      episodes_watched: 10,
      seasons: [
        {
          season_number: 1,
          episodes_watched: 10,
          episodes: [
            {
              season: 1,
              episode: 1,
              title: 'Currahee',
              watched_at: '2024-01-15T20:00:00Z',
            },
            {
              season: 1,
              episode: 2,
              title: 'Day of Days',
              watched_at: '2024-01-16T20:00:00Z',
            },
          ],
        },
      ],
    },
  },

  getWatchingShowSeason: {
    data: {
      season_number: 1,
      episodes: [
        {
          season: 1,
          episode: 1,
          title: 'Currahee',
          watched_at: '2024-01-15T20:00:00Z',
        },
        {
          season: 1,
          episode: 2,
          title: 'Day of Days',
          watched_at: '2024-01-16T20:00:00Z',
        },
      ],
    },
  },

  listWatchingRatings: {
    data: [
      {
        movie: {
          id: 50,
          title: 'The Great Escape',
          year: 1963,
          tmdb_id: 5925,
          tmdb_rating: 7.9,
          image: IMAGE.movie,
        },
        user_rating: 5,
        review_url: null,
        watched_at: '2025-08-10T20:00:00Z',
        source: 'letterboxd',
      },
      {
        movie: {
          id: 200,
          title: 'Interstellar',
          year: 2014,
          tmdb_id: 157336,
          tmdb_rating: 8.4,
          image: IMAGE.movie,
        },
        user_rating: 5,
        review_url: null,
        watched_at: '2024-12-20T20:00:00Z',
        source: 'letterboxd',
      },
    ],
    pagination: PAGINATION,
  },

  listWatchingReviews: {
    data: [
      {
        movie: {
          id: 50,
          title: 'The Great Escape',
          year: 1963,
          tmdb_id: 5925,
          image: IMAGE.movie,
        },
        user_rating: 5,
        review: 'An absolute masterpiece of tension and camaraderie.',
        review_url: 'https://letterboxd.com/user/film/the-great-escape/',
        watched_at: '2025-08-10T20:00:00Z',
        source: 'letterboxd',
      },
    ],
    pagination: PAGINATION,
  },

  getWatchingYearInReview: {
    data: {
      year: 2025,
      total_movies: 95,
      total_watch_time_hours: 185,
      top_rated: [
        {
          movie: {
            id: 50,
            title: 'The Great Escape',
            year: 1963,
            tmdb_id: 5925,
            image: IMAGE.movie,
          },
          user_rating: 5,
          watched_at: '2025-08-10T20:00:00Z',
        },
      ],
      genre_breakdown: [
        { genre: 'Drama', count: 35 },
        { genre: 'Action', count: 20 },
      ],
      decade_breakdown: [
        { decade: 2020, count: 30 },
        { decade: 1960, count: 8 },
      ],
    },
  },

  // ─── Collecting ───
  getCollectingStats: {
    data: {
      total_items: 284,
      by_format: { vinyl: 253, cd: 29, cassette: 0, other: 2 },
      wantlist_count: 1,
      unique_artists: 107,
      estimated_value: 7394.51,
      top_genre: 'Rock',
      oldest_release_year: 1957,
      newest_release_year: 2025,
      most_collected_artist: { name: 'Taylor Swift', count: 24 },
      added_this_year: 139,
    },
  },

  getCollectingRecent: {
    data: [
      {
        id: 1,
        discogs_id: 6872464,
        title: 'Nevermind',
        artists: ['Nirvana'],
        year: 1991,
        format: 'Vinyl',
        format_detail: '["LP","Album"]',
        label: '[{"name":"DGC","catno":"DGC-24425"}]',
        genres: ['Rock'],
        styles: ['Grunge', 'Alternative Rock'],
        image: IMAGE.vinyl,
        date_added: '2026-03-11T16:05:58-07:00',
        rating: 0,
        discogs_url: 'https://www.discogs.com/release/6872464',
      },
    ],
    pagination: PAGINATION,
  },

  getCollectionRecord: {
    data: {
      id: 1,
      discogs_id: 6872464,
      title: 'Nevermind',
      artists: ['Nirvana'],
      year: 1991,
      format: 'Vinyl',
      format_detail: '["LP","Album"]',
      label: '[{"name":"DGC","catno":"DGC-24425"}]',
      genres: ['Rock'],
      styles: ['Grunge', 'Alternative Rock'],
      image: IMAGE.vinyl,
      date_added: '2026-03-11T16:05:58-07:00',
      rating: 0,
      discogs_url: 'https://www.discogs.com/release/6872464',
    },
  },

  listCollectingWantlist: {
    data: [
      {
        id: 100,
        discogs_id: 9999999,
        title: 'In Utero',
        artists: ['Nirvana'],
        year: 1993,
        format: 'Vinyl',
        genres: ['Rock'],
        styles: ['Grunge'],
        discogs_url: 'https://www.discogs.com/release/9999999',
      },
    ],
    pagination: PAGINATION,
  },

  listCollectingFormats: {
    data: [
      { format: 'Vinyl', count: 253 },
      { format: 'CD', count: 29 },
      { format: 'Cassette', count: 0 },
      { format: 'Other', count: 2 },
    ],
  },

  listCollectingGenres: {
    data: [
      { genre: 'Rock', count: 120 },
      { genre: 'Pop', count: 45 },
      { genre: 'Hip Hop', count: 38 },
    ],
  },

  listCollectingArtists: {
    data: [
      { artist: 'Taylor Swift', count: 24 },
      { artist: 'Nirvana', count: 5 },
      { artist: 'Beastie Boys', count: 3 },
    ],
  },

  getCollectingCrossReference: {
    data: [
      {
        record: { id: 1, title: 'Nevermind', artists: ['Nirvana'] },
        listening: { playcount: 333, last_played: '2026-02-15T20:00:00Z' },
      },
    ],
    pagination: PAGINATION,
  },

  getCollectingCalendar: {
    year: 2026,
    days: [
      { date: '2026-01-15', count: 3 },
      { date: '2026-02-01', count: 5 },
    ],
  },

  // ─── Collecting Media ───
  listCollectingMedia: {
    data: [
      {
        id: 1,
        title: 'Top Gun: Maverick',
        year: 2022,
        tmdb_id: 361743,
        format: 'Blu-ray',
        image: IMAGE.movie,
        date_added: '2026-01-15T00:00:00Z',
      },
      {
        id: 2,
        title: 'The Great Escape',
        year: 1963,
        tmdb_id: 5925,
        format: '4K UHD',
        image: IMAGE.movie,
        date_added: '2025-12-25T00:00:00Z',
      },
      {
        id: 3,
        title: 'Interstellar',
        year: 2014,
        tmdb_id: 157336,
        format: '4K UHD',
        image: IMAGE.movie,
        date_added: '2025-11-10T00:00:00Z',
      },
    ],
    pagination: PAGINATION,
  },

  getCollectingMediaStats: {
    data: {
      total_items: 45,
      by_format: { 'Blu-ray': 25, '4K UHD': 15, DVD: 5 },
    },
  },

  getCollectingMediaRecent: {
    data: [
      {
        id: 1,
        title: 'Top Gun: Maverick',
        year: 2022,
        format: 'Blu-ray',
        image: IMAGE.movie,
        date_added: '2026-01-15T00:00:00Z',
      },
    ],
    pagination: PAGINATION,
  },

  listCollectingMediaFormats: {
    data: [
      { format: 'Blu-ray', count: 25 },
      { format: '4K UHD', count: 15 },
      { format: 'DVD', count: 5 },
    ],
  },

  getCollectingMediaCrossReference: {
    data: [
      {
        media: { id: 2, title: 'The Great Escape', year: 1963 },
        watched: true,
        last_watched: '2025-08-10T20:00:00Z',
      },
      {
        media: { id: 3, title: 'Interstellar', year: 2014 },
        watched: true,
        last_watched: '2024-12-20T20:00:00Z',
      },
    ],
    pagination: PAGINATION,
  },

  getCollectingMediaItem: {
    data: {
      id: 2,
      title: 'The Great Escape',
      year: 1963,
      tmdb_id: 5925,
      format: '4K UHD',
      image: IMAGE.movie,
      date_added: '2025-12-25T00:00:00Z',
    },
  },

  // ─── Feed ───
  getFeedByDomain: {
    data: [
      {
        id: 2491,
        domain: 'watching',
        event_type: 'movie_watched',
        occurred_at: '2026-03-18T20:11:30.741Z',
        title: "Watched Ferris Bueller's Day Off (1986)",
        subtitle: null,
        image_key: null,
        source_id: 'plex:webhook:123',
        metadata: null,
        created_at: '2026-03-18T20:11:30.762Z',
      },
    ],
    pagination: { next_cursor: '2491', has_more: true, limit: 20 },
  },

  getFeedOnThisDay: {
    data: [
      {
        id: 500,
        domain: 'listening',
        event_type: 'artist_discovered',
        occurred_at: '2024-03-18T15:00:00.000Z',
        title: 'Discovered Sabrina Carpenter',
        subtitle: null,
        image_key: null,
        source_id: 'lastfm:sync:abc',
        metadata: null,
        created_at: '2024-03-18T15:00:00.000Z',
      },
    ],
  },

  // ─── Images ───
  getImage: null, // Redirects to CDN, no JSON response
};

// Output as JSON
console.log(JSON.stringify(examples, null, 2));
