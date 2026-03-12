import {
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
  index,
} from 'drizzle-orm/sqlite-core';

export const stravaTokens = sqliteTable(
  'strava_tokens',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').notNull().default(1),
    accessToken: text('access_token').notNull(),
    refreshToken: text('refresh_token').notNull(),
    expiresAt: integer('expires_at').notNull(),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    updatedAt: text('updated_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [index('idx_strava_tokens_user_id').on(table.userId)]
);

export const stravaActivities = sqliteTable(
  'strava_activities',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').notNull().default(1),
    stravaId: integer('strava_id').notNull(),
    name: text('name').notNull(),
    sportType: text('sport_type').notNull().default('Run'),
    workoutType: integer('workout_type').default(0),
    distanceMeters: real('distance_meters').notNull().default(0),
    distanceMiles: real('distance_miles').notNull().default(0),
    movingTimeSeconds: integer('moving_time_seconds').notNull().default(0),
    elapsedTimeSeconds: integer('elapsed_time_seconds').notNull().default(0),
    totalElevationGainMeters: real('total_elevation_gain_meters')
      .notNull()
      .default(0),
    totalElevationGainFeet: real('total_elevation_gain_feet')
      .notNull()
      .default(0),
    startDate: text('start_date').notNull(),
    startDateLocal: text('start_date_local').notNull(),
    timezone: text('timezone'),
    startLat: real('start_lat'),
    startLng: real('start_lng'),
    city: text('city'),
    state: text('state'),
    country: text('country'),
    averageSpeedMs: real('average_speed_ms'),
    maxSpeedMs: real('max_speed_ms'),
    paceMinPerMile: real('pace_min_per_mile'),
    paceFormatted: text('pace_formatted'),
    averageHeartrate: real('average_heartrate'),
    maxHeartrate: real('max_heartrate'),
    averageCadence: real('average_cadence'),
    calories: integer('calories'),
    sufferScore: integer('suffer_score'),
    mapPolyline: text('map_polyline'),
    gearId: text('gear_id'),
    achievementCount: integer('achievement_count').default(0),
    prCount: integer('pr_count').default(0),
    isRace: integer('is_race').notNull().default(0),
    isDeleted: integer('is_deleted').notNull().default(0),
    stravaUrl: text('strava_url'),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    updatedAt: text('updated_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    uniqueIndex('idx_strava_activities_user_strava').on(table.userId, table.stravaId),
    index('idx_strava_activities_user_id').on(table.userId),
    index('idx_strava_activities_start_date').on(table.startDate),
    index('idx_strava_activities_city').on(table.city),
    index('idx_strava_activities_gear_id').on(table.gearId),
    index('idx_strava_activities_workout_type').on(table.workoutType),
    index('idx_strava_activities_is_deleted').on(table.isDeleted),
  ]
);

export const stravaSplits = sqliteTable(
  'strava_splits',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').notNull().default(1),
    activityStravaId: integer('activity_strava_id').notNull(),
    splitNumber: integer('split_number').notNull(),
    distanceMeters: real('distance_meters').notNull(),
    distanceMiles: real('distance_miles').notNull(),
    movingTimeSeconds: integer('moving_time_seconds').notNull(),
    elapsedTimeSeconds: integer('elapsed_time_seconds').notNull(),
    elevationDifferenceMeters: real('elevation_difference_meters'),
    elevationDifferenceFeet: real('elevation_difference_feet'),
    averageSpeedMs: real('average_speed_ms'),
    paceMinPerMile: real('pace_min_per_mile'),
    paceFormatted: text('pace_formatted'),
    averageHeartrate: real('average_heartrate'),
    averageCadence: real('average_cadence'),
  },
  (table) => [
    index('idx_strava_splits_activity').on(table.activityStravaId),
    index('idx_strava_splits_user_id').on(table.userId),
    index('idx_strava_splits_user_activity').on(table.userId, table.activityStravaId),
  ]
);

export const stravaGear = sqliteTable(
  'strava_gear',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').notNull().default(1),
    stravaGearId: text('strava_gear_id').notNull(),
    name: text('name').notNull(),
    brand: text('brand'),
    model: text('model'),
    distanceMeters: real('distance_meters').notNull().default(0),
    distanceMiles: real('distance_miles').notNull().default(0),
    isRetired: integer('is_retired').notNull().default(0),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    updatedAt: text('updated_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    uniqueIndex('idx_strava_gear_strava_gear_id').on(table.stravaGearId),
    index('idx_strava_gear_user_id').on(table.userId),
  ]
);

export const stravaPersonalRecords = sqliteTable(
  'strava_personal_records',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').notNull().default(1),
    distance: text('distance').notNull(),
    distanceLabel: text('distance_label').notNull(),
    timeSeconds: integer('time_seconds').notNull(),
    timeFormatted: text('time_formatted').notNull(),
    paceFormatted: text('pace_formatted').notNull(),
    date: text('date').notNull(),
    activityStravaId: integer('activity_strava_id').notNull(),
    activityName: text('activity_name').notNull(),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    uniqueIndex('idx_strava_prs_unique').on(table.userId, table.distance),
    index('idx_strava_prs_user_id').on(table.userId),
  ]
);

export const stravaYearSummaries = sqliteTable(
  'strava_year_summaries',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').notNull().default(1),
    year: integer('year').notNull(),
    totalRuns: integer('total_runs').notNull().default(0),
    totalDistanceMiles: real('total_distance_miles').notNull().default(0),
    totalElevationFeet: real('total_elevation_feet').notNull().default(0),
    totalDurationSeconds: integer('total_duration_seconds')
      .notNull()
      .default(0),
    avgPaceFormatted: text('avg_pace_formatted'),
    longestRunMiles: real('longest_run_miles').notNull().default(0),
    raceCount: integer('race_count').notNull().default(0),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    updatedAt: text('updated_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    uniqueIndex('idx_strava_year_summaries_unique').on(
      table.userId,
      table.year
    ),
    index('idx_strava_year_summaries_user_id').on(table.userId),
  ]
);

export const stravaLifetimeStats = sqliteTable(
  'strava_lifetime_stats',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').notNull().default(1),
    totalRuns: integer('total_runs').notNull().default(0),
    totalDistanceMiles: real('total_distance_miles').notNull().default(0),
    totalElevationFeet: real('total_elevation_feet').notNull().default(0),
    totalDurationSeconds: integer('total_duration_seconds')
      .notNull()
      .default(0),
    avgPaceFormatted: text('avg_pace_formatted'),
    yearsActive: integer('years_active').notNull().default(0),
    firstRun: text('first_run'),
    eddingtonNumber: integer('eddington_number').notNull().default(0),
    currentStreakDays: integer('current_streak_days').notNull().default(0),
    currentStreakStart: text('current_streak_start'),
    currentStreakEnd: text('current_streak_end'),
    longestStreakDays: integer('longest_streak_days').notNull().default(0),
    longestStreakStart: text('longest_streak_start'),
    longestStreakEnd: text('longest_streak_end'),
    updatedAt: text('updated_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [uniqueIndex('idx_strava_lifetime_stats_user_id').on(table.userId)]
);
