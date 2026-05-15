/**
 * Output schemas for the attending-domain tools (issue #105).
 *
 * These schemas are the source of truth for the attending tools' return
 * shapes. `attending.ts` derives its event / player / stats types from
 * them via `z.infer` where the structuredContent shape is exactly the
 * tool's return shape, so the declared schema and the TypeScript type
 * cannot drift. Raw MLB Stats API stat-line objects (`batting_line`,
 * `pitching_line`, `season_stats.hitter`, etc.) have dynamic, uncertain
 * keys -- they are modelled as `z.record(z.unknown())` rather than
 * enumerated.
 *
 * Every object schema uses `.passthrough()` so the JSON Schema advertised
 * to clients stays `additionalProperties`-open -- a field the Rewind API
 * adds later does not break client-side validation. See schemas/shared.ts.
 */
import { z } from 'zod';
import { imageSchema, paginationSchema } from './shared.js';

// --- Element schemas ------------------------------------------------------

/**
 * An opaque MLB Stats API stat line -- dynamic keys, modelled loosely.
 * A factory: get_attended_player uses it ~16 times, and the JSON Schema
 * converter would emit `$ref`s if they were all the same object.
 */
const statLineSchema = () => z.record(z.unknown());

/** A venue reference attached to an attended event (null when unknown). */
const venueSchema = z
  .object({
    id: z.number(),
    name: z.string(),
    city: z.string().nullable(),
    state: z.string().nullable(),
    country: z.string().nullable(),
    capacity: z.number().nullable(),
  })
  .passthrough()
  .nullable();

/**
 * Full team object, inlined wherever a team is referenced. Mirrors
 * src/lib/schemas/team.ts on the API side. Null when no team applies
 * (e.g. a concert with no sports team).
 */
const teamSchema = () =>
  z
    .object({
      id: z.number(),
      league: z.string(),
      abbreviation: z.string(),
      location: z.string().nullable(),
      name: z.string(),
      full_name: z.string().nullable(),
      primary_color: z.string().nullable(),
      secondary_color: z.string().nullable(),
      tertiary_color: z.string().nullable(),
      ui_tint_color: z.string().nullable(),
      logo_url: z.string().nullable(),
      logo_dark_url: z.string().nullable(),
      logo_light_url: z.string().nullable(),
      conference: z.string().nullable(),
      division: z.string().nullable(),
    })
    .passthrough()
    .nullable();

/** A player as listed by get_attended_players. */
export const playerSchema = z
  .object({
    id: z.number(),
    league: z.string(),
    mlb_stats_id: z.number().nullable(),
    espn_id: z.string().nullable(),
    full_name: z.string(),
    primary_position: z.string().nullable(),
    primary_number: z.string().nullable(),
    birth_date: z.string().nullable(),
    birth_country: z.string().nullable(),
    bats: z.string().nullable(),
    throws: z.string().nullable(),
    primary_team: teamSchema(),
    debut_date: z.string().nullable(),
    photo_silo: imageSchema(),
    photo_full: imageSchema(),
  })
  .passthrough();

/** A per-player appearance line within an attended event. */
const appearanceSchema = z
  .object({
    player: playerSchema,
    team: teamSchema(),
    is_home: z.boolean(),
    batting_line: statLineSchema().nullable(),
    pitching_line: statLineSchema().nullable(),
    fielding_line: statLineSchema().nullable(),
    decision: z.enum(['W', 'L', 'SV', 'HLD', 'BS']).nullable(),
    notable: z.boolean(),
  })
  .passthrough();

/** An attended event, as listed by get_attended_events / get_attended_season. */
export const attendedEventSchema = z
  .object({
    id: z.number(),
    category: z.enum(['sports', 'music', 'arts']),
    event_type: z.string(),
    event_date: z.string(),
    event_datetime: z.string().nullable(),
    title: z.string(),
    subtitle: z.string().nullable(),
    external_id: z.string().nullable(),
    external_source: z.string().nullable(),
    event_data: z.record(z.unknown()).nullable(),
    notes: z.string().nullable(),
    attended: z.boolean(),
    venue: venueSchema,
    tickets: z.array(z.unknown()),
  })
  .passthrough();

// --- Tool output schemas --------------------------------------------------

/** outputSchema for get_attended_events. Empty branch keeps the same shape. */
export const attendedEventsOutputSchema = z
  .object({
    data: z.array(attendedEventSchema),
    pagination: paginationSchema(),
  })
  .passthrough();

/** outputSchema for get_attended_players. Empty branch keeps the same shape. */
export const attendedPlayersOutputSchema = z
  .object({
    data: z.array(playerSchema),
    pagination: paginationSchema(),
  })
  .passthrough();

/** outputSchema for get_attended_season. */
export const attendedSeasonOutputSchema = z
  .object({
    league: z.string(),
    season: z.number(),
    attended_count: z.number(),
    wins: z.number(),
    losses: z.number(),
    data: z.array(attendedEventSchema),
  })
  .passthrough();

/**
 * outputSchema for get_attended_event. Extends the event shape with the
 * full per-player appearance list.
 */
export const attendedEventDetailOutputSchema = z
  .object({
    id: z.number(),
    category: z.enum(['sports', 'music', 'arts']),
    event_type: z.string(),
    event_date: z.string(),
    event_datetime: z.string().nullable(),
    title: z.string(),
    subtitle: z.string().nullable(),
    external_id: z.string().nullable(),
    external_source: z.string().nullable(),
    event_data: z.record(z.unknown()).nullable(),
    notes: z.string().nullable(),
    attended: z.boolean(),
    venue: venueSchema,
    tickets: z.array(z.unknown()),
    players: z.array(appearanceSchema),
  })
  .passthrough();

/** outputSchema for get_attending_stats. */
export const attendingStatsOutputSchema = z
  .object({
    total_events: z.number(),
    attended_events: z.number(),
    by_category: z.array(
      z.object({ category: z.string(), count: z.number() }).passthrough()
    ),
    by_event_type: z.array(
      z.object({ event_type: z.string(), count: z.number() }).passthrough()
    ),
    by_year: z.array(
      z.object({ year: z.string(), count: z.number() }).passthrough()
    ),
  })
  .passthrough();

/** outputSchema for get_attending_year_in_review. */
export const attendingYearInReviewOutputSchema = z
  .object({
    year: z.number(),
    total_events: z.number(),
    total_spent_cents: z.number(),
    by_category: z.array(
      z.object({ category: z.string(), count: z.number() }).passthrough()
    ),
    by_event_type: z.array(
      z.object({ event_type: z.string(), count: z.number() }).passthrough()
    ),
    monthly: z.array(
      z.object({ month: z.string(), count: z.number() }).passthrough()
    ),
    top_venues: z.array(
      z
        .object({
          venue_id: z.number(),
          name: z.string(),
          city: z.string().nullable(),
          count: z.number(),
        })
        .passthrough()
    ),
    top_performers: z.array(
      z
        .object({
          performer_id: z.number(),
          name: z.string(),
          count: z.number(),
        })
        .passthrough()
    ),
    events: z.array(
      z
        .object({
          id: z.number(),
          event_date: z.string(),
          event_type: z.string(),
          title: z.string(),
          subtitle: z.string().nullable(),
          venue_name: z.string().nullable(),
        })
        .passthrough()
    ),
  })
  .passthrough();

/**
 * outputSchema for get_attended_player_stats. The handler returns the raw
 * API response unchanged -- a discriminated union on `supported`. The MCP
 * SDK requires `outputSchema` to be a single object schema, so this is
 * modelled as one permissive `.passthrough()` object: fields that exist on
 * only one branch (`batting`/`pitching`/`games` on supported=true,
 * `reason`/`appearances` on supported=false) are `.optional()`, so both
 * branches conform. `supported` discriminates.
 */
const playerStatsPlayerSchema = z
  .object({
    id: z.number(),
    full_name: z.string(),
    primary_position: z.string().nullable(),
    primary_team: teamSchema(),
  })
  .passthrough();

export const attendedPlayerStatsOutputSchema = z
  .object({
    supported: z.boolean(),
    league: z.string(),
    scope: z.enum(['career', 'season']),
    season: z.number().optional(),
    player: playerStatsPlayerSchema,
    // supported=true branch
    hitter: z.literal(true).optional(),
    pitcher: z.literal(true).optional(),
    games: z.number().optional(),
    games_with_box_score: z.number().optional(),
    batting: z
      .object({
        pa: z.number(),
        ab: z.number(),
        h: z.number(),
        hr: z.number(),
        rbi: z.number(),
        bb: z.number(),
        k: z.number(),
        sb: z.number(),
        avg: z.string().nullable(),
        slg: z.string().nullable(),
      })
      .passthrough()
      .optional(),
    pitching: z
      .object({
        ip: z.string(),
        bf: z.number(),
        k: z.number(),
        bb: z.number(),
        er: z.number(),
        era: z.string().nullable(),
        whip: z.string().nullable(),
        decisions: z
          .object({
            w: z.number(),
            l: z.number(),
            sv: z.number(),
            hld: z.number(),
            bs: z.number(),
          })
          .passthrough(),
      })
      .passthrough()
      .optional(),
    // supported=false branch
    reason: z.string().optional(),
    appearances: z
      .array(
        z
          .object({
            event_id: z.number(),
            event_date: z.string(),
            title: z.string(),
            home_team: z.string().nullable(),
            away_team: z.string().nullable(),
            final_score: z.string().nullable(),
            my_team_won: z.boolean().nullable(),
          })
          .passthrough()
      )
      .optional(),
  })
  .passthrough();

/**
 * outputSchema for get_attended_player. The handler builds a transformed,
 * nested DESIGN.md-shaped payload -- this schema describes that built shape,
 * not the raw `/attending/players/:id` API response. The MLB stat blocks
 * (`season_stats.hitter`, `career.seasons`, `splits.*`, `attended_summary.*`)
 * have dynamic keys and are modelled as `z.record(z.unknown())`. The
 * `season_stats`, `career`, `splits`, and `season_attended_summary` objects
 * are nullable -- absent for non-MLB players or out-of-season.
 */
export const attendedPlayerOutputSchema = z
  .object({
    player: z
      .object({
        id: z.number(),
        mlb_stats_id: z.number().nullable(),
        full_name: z.string(),
        primary_position: z.string().nullable(),
        primary_number: z.string().nullable(),
        bats: z.string().nullable(),
        throws: z.string().nullable(),
        debut_date: z.string().nullable(),
        birth_date: z.string().nullable(),
        birth_city: z.string().nullable(),
        birth_state_province: z.string().nullable(),
        birth_country: z.string().nullable(),
        height: z.string().nullable(),
        weight: z.number().nullable(),
        college_name: z.string().nullable(),
        awards: z.array(
          z
            .object({
              season: z.string(),
              id: z.string(),
              name: z.string(),
            })
            .passthrough()
        ),
        photo_silo: imageSchema(),
        photo_full: imageSchema(),
        league: z.string(),
        primary_team: teamSchema(),
      })
      .passthrough(),
    supported: z.boolean(),
    season_stats: z
      .object({
        season: z.number(),
        fetched_at: z.string(),
        cache_hit: z.boolean(),
        hitter: statLineSchema().nullable(),
        pitcher: statLineSchema().nullable(),
      })
      .passthrough()
      .nullable(),
    career: z
      .object({
        group: z.enum(['hitting', 'pitching']),
        seasons: z.array(statLineSchema()),
        fetched_at: z.string(),
        cache_hit: z.boolean(),
      })
      .passthrough()
      .nullable(),
    splits: z
      .object({
        season: z.number(),
        group: z.enum(['hitting', 'pitching']),
        home: statLineSchema().nullable(),
        away: statLineSchema().nullable(),
        vs_left: statLineSchema().nullable(),
        vs_right: statLineSchema().nullable(),
        fetched_at: z.string(),
        cache_hit: z.boolean(),
      })
      .passthrough()
      .nullable(),
    attended_summary: z
      .object({
        games_attended: z.number(),
        games_with_box_score: z.number(),
        wins: z.number(),
        losses: z.number(),
        hitter: statLineSchema().nullable(),
        pitcher: statLineSchema().nullable(),
      })
      .passthrough(),
    season_attended_summary: z
      .object({
        games_attended: z.number(),
        games_with_box_score: z.number(),
        wins: z.number(),
        losses: z.number(),
        hitter: statLineSchema().nullable(),
        pitcher: statLineSchema().nullable(),
      })
      .passthrough()
      .nullable(),
    season_attended_summary_season: z.number().nullable(),
    attended_appearances: z.array(
      z
        .object({
          event_id: z.number(),
          event_date: z.string(),
          title: z.string(),
          is_home: z.boolean(),
          batting_line: statLineSchema().nullable(),
          pitching_line: statLineSchema().nullable(),
          decision: z.enum(['W', 'L', 'SV', 'HLD', 'BS']).nullable(),
          notable: z.boolean(),
          notable_reasons: z.array(z.string()),
        })
        .passthrough()
    ),
    attended_appearance_count: z.number(),
  })
  .passthrough();
