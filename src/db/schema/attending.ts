import {
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
  index,
  primaryKey,
} from 'drizzle-orm/sqlite-core';
import { lastfmArtists } from './lastfm.js';

// Venues: where events happen. Normalized so re-attended venues
// (T-Mobile Park, Climate Pledge Arena, Lumen Field, ...) get joined cleanly.
// `aliases` carries historical names ('Safeco Field') so calendar/email
// parsers can resolve old entries to the current venue row.
export const venues = sqliteTable(
  'venues',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').notNull().default(1),
    name: text('name').notNull(),
    aliases: text('aliases'), // JSON: string[]
    city: text('city'),
    state: text('state'),
    country: text('country'),
    latitude: real('latitude'),
    longitude: real('longitude'),
    capacity: integer('capacity'),
    externalIds: text('external_ids'), // JSON: { foursquare, google_place_id, ... }
    imageKey: text('image_key'),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    updatedAt: text('updated_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    uniqueIndex('idx_venues_user_name').on(table.userId, table.name),
    index('idx_venues_city').on(table.city),
  ]
);

// Performers: musical artists, comedians, theater companies, speakers.
// `lastfmArtistId` is the cross-domain link to listening — populated by
// enrichment when a concert performer matches a known scrobbled artist.
// Sports teams are NOT modeled here; team metadata lives in
// attendedEvents.eventData JSON for sports event types.
export const performers = sqliteTable(
  'performers',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').notNull().default(1),
    name: text('name').notNull(),
    performerType: text('performer_type', {
      enum: [
        'musical_artist',
        'comedian',
        'theater_company',
        'speaker',
        'other',
      ],
    })
      .notNull()
      .default('musical_artist'),
    mbid: text('mbid'),
    lastfmArtistId: integer('lastfm_artist_id').references(
      () => lastfmArtists.id
    ),
    externalIds: text('external_ids'), // JSON: { setlist_fm, spotify, apple_music_id, ... }
    imageKey: text('image_key'),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    updatedAt: text('updated_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    uniqueIndex('idx_performers_user_name_type').on(
      table.userId,
      table.name,
      table.performerType
    ),
    index('idx_performers_mbid').on(table.mbid),
    index('idx_performers_lastfm_artist').on(table.lastfmArtistId),
  ]
);

// Polymorphic core. One row per event date you bought tickets for —
// `attended` defaults to 1 but can be flipped to 0 for tickets you
// purchased then skipped. Type-specific fields live in `eventData` (JSON);
// promote to real columns when actual queries demand it.
//
// eventData by type:
//   mlb_game / nfl_game / nba_game / wnba_game / mls_game:
//     { league, home_team: { id, abbr, name }, away_team: { ... },
//       home_score, away_score, my_team: 'home'|'away',
//       my_team_won: bool, season, game_pk|espn_id, game_type, innings? }
//   concert / festival:
//     { tour, setlist_fm_id?, notes? }   // performers live in join table
//   theater / opera / dance / comedy:
//     { production_title?, run_name?, ... }
export const attendedEvents = sqliteTable(
  'attended_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').notNull().default(1),
    category: text('category', {
      enum: ['sports', 'music', 'arts'],
    }).notNull(),
    eventType: text('event_type').notNull(),
    eventDate: text('event_date').notNull(), // YYYY-MM-DD (local to venue)
    eventDatetime: text('event_datetime'), // ISO 8601, when known
    venueId: integer('venue_id').references(() => venues.id),
    title: text('title').notNull(),
    subtitle: text('subtitle'),
    seriesId: text('series_id'), // groups festival/series rows
    externalId: text('external_id'),
    externalSource: text('external_source'),
    eventData: text('event_data'), // JSON, type-specific
    notes: text('notes'),
    attended: integer('attended').notNull().default(1),
    imageKey: text('image_key'),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    updatedAt: text('updated_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    uniqueIndex('idx_attended_events_external').on(
      table.externalSource,
      table.externalId
    ),
    index('idx_attended_events_user_date').on(table.userId, table.eventDate),
    index('idx_attended_events_type_date').on(table.eventType, table.eventDate),
    index('idx_attended_events_category').on(table.category),
    index('idx_attended_events_venue').on(table.venueId),
    index('idx_attended_events_series').on(table.seriesId),
  ]
);

// Many-to-many: events ↔ performers, with role/billing.
// Headliner + opener pattern for concerts; festivals can have many headliners.
export const attendedEventPerformers = sqliteTable(
  'attended_event_performers',
  {
    eventId: integer('event_id')
      .notNull()
      .references(() => attendedEvents.id, { onDelete: 'cascade' }),
    performerId: integer('performer_id')
      .notNull()
      .references(() => performers.id),
    role: text('role', {
      enum: ['headliner', 'opener', 'support', 'guest', 'mc'],
    })
      .notNull()
      .default('headliner'),
    billingOrder: integer('billing_order').notNull().default(0),
  },
  (table) => [
    primaryKey({ columns: [table.eventId, table.performerId] }),
    index('idx_attended_event_performers_performer').on(table.performerId),
  ]
);

// One row per ticket order (a pair bought together = one row).
// Multiple ticket rows per event are valid (resold + replaced, separate
// purchases for a group, etc.). Split per-seat only if a real query needs it.
export const attendedEventTickets = sqliteTable(
  'attended_event_tickets',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').notNull().default(1),
    eventId: integer('event_id')
      .notNull()
      .references(() => attendedEvents.id, { onDelete: 'cascade' }),
    vendor: text('vendor', {
      enum: [
        'ticketmaster',
        'seatgeek',
        'ticketclub',
        'axs',
        'stubhub',
        'vivid_seats',
        'box_office',
        'comp',
        'paper',
        'manual',
      ],
    }).notNull(),
    orderId: text('order_id'),
    section: text('section'),
    row: text('row'),
    seat: text('seat'),
    quantity: integer('quantity').notNull().default(1),
    totalPriceCents: integer('total_price_cents'),
    currency: text('currency').notNull().default('USD'),
    purchasedAt: text('purchased_at'),
    sourceType: text('source_type', { enum: ['gmail', 'manual'] })
      .notNull()
      .default('manual'),
    sourceRef: text('source_ref'),
    rawData: text('raw_data'), // JSON, parser output
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    index('idx_attended_event_tickets_event').on(table.eventId),
    index('idx_attended_event_tickets_vendor').on(table.vendor),
    uniqueIndex('idx_attended_event_tickets_vendor_order').on(
      table.vendor,
      table.orderId
    ),
  ]
);

// Provenance trail for backfill + dedupe debugging. Every candidate event
// (calendar entry, ticket email, manual add, MLB Stats API match) writes
// a row here with its raw payload so parsers can be re-run without
// losing context. eventId is nullable so unmatched candidates can be
// inspected before promotion to attended_events.
export const attendedEventSources = sqliteTable(
  'attended_event_sources',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').notNull().default(1),
    eventId: integer('event_id').references(() => attendedEvents.id, {
      onDelete: 'cascade',
    }),
    sourceType: text('source_type', {
      enum: ['gcal', 'gmail', 'manual', 'mlb_stats_api', 'espn', 'setlist_fm'],
    }).notNull(),
    sourceRef: text('source_ref').notNull(),
    rawData: text('raw_data'), // JSON snapshot
    matchConfidence: real('match_confidence'),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    uniqueIndex('idx_attended_event_sources_unique').on(
      table.sourceType,
      table.sourceRef
    ),
    index('idx_attended_event_sources_event').on(table.eventId),
  ]
);

// Players: the people on the field/court for sports events I attended.
// Modeled separately from `performers` (musical artists/comedians) because
// the schema is genuinely different — players have positions, jersey
// numbers, batting/pitching hands, debut dates. Cross-source IDs:
// `mlbStatsId` from the MLB Stats API roster + boxscore endpoints,
// `espnId` from ESPN game summaries (resolved via name+jersey match).
//
// Photos live in the shared `images` table keyed on
// (domain='attending', entity_type='player_silo'|'player_full',
// entity_id=String(player.id)). Both the MLB silo cutout and the ESPN
// full-body PNG are stored when both sources resolve.
export const players = sqliteTable(
  'players',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').notNull().default(1),
    league: text('league').notNull(), // 'mlb', 'nfl', 'nba', 'wnba', 'ncaaf', 'ncaab', 'mls'
    mlbStatsId: integer('mlb_stats_id'),
    espnId: text('espn_id'),
    fullName: text('full_name').notNull(),
    firstName: text('first_name'),
    lastName: text('last_name'),
    primaryPosition: text('primary_position'),
    primaryNumber: text('primary_number'), // jersey, kept as string ("00", "13", etc.)
    birthDate: text('birth_date'), // YYYY-MM-DD
    birthCity: text('birth_city'),
    birthCountry: text('birth_country'),
    bats: text('bats'), // L/R/B
    throws: text('throws'), // L/R
    primaryTeamId: integer('primary_team_id'), // league-specific team id
    debutDate: text('debut_date'),
    bioData: text('bio_data'), // JSON: any extra fields we want to keep around
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    updatedAt: text('updated_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    uniqueIndex('idx_players_league_mlb_stats_id').on(
      table.league,
      table.mlbStatsId
    ),
    uniqueIndex('idx_players_league_espn_id').on(table.league, table.espnId),
    index('idx_players_team').on(table.primaryTeamId),
    index('idx_players_last_name').on(table.lastName),
  ]
);

// Per-game appearance: who played in a specific event, and what they did.
// One row per (event, player). Roles aren't enforced — a player can have
// both a batting line and a pitching line in the same row (interleague
// pitcher hits, position player pitching, etc.). `decision` is set on
// the pitcher of record. `notable` is a denormalized boolean we set
// during sync for fast filtering ("show me the standout performances").
export const attendedEventPlayers = sqliteTable(
  'attended_event_players',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').notNull().default(1),
    eventId: integer('event_id')
      .notNull()
      .references(() => attendedEvents.id, { onDelete: 'cascade' }),
    playerId: integer('player_id')
      .notNull()
      .references(() => players.id),
    teamId: integer('team_id'), // which team they played for in this game
    isHome: integer('is_home').notNull().default(0), // 0/1
    battingLine: text('batting_line'), // JSON: AB/R/H/RBI/BB/K/HR/avg/obp/slg/order
    pitchingLine: text('pitching_line'), // JSON: IP/H/R/ER/BB/K/HR/pitches/strikes/era
    fieldingLine: text('fielding_line'), // JSON: position-by-position innings
    decision: text('decision', { enum: ['W', 'L', 'SV', 'HLD', 'BS'] }),
    notable: integer('notable').notNull().default(0),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    uniqueIndex('idx_attended_event_players_unique').on(
      table.eventId,
      table.playerId
    ),
    index('idx_attended_event_players_event').on(table.eventId),
    index('idx_attended_event_players_player').on(table.playerId),
    index('idx_attended_event_players_decision').on(table.decision),
    index('idx_attended_event_players_notable').on(table.notable),
  ]
);
