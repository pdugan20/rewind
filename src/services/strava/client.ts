import type { Database } from '../../db/client.js';
import type { Env } from '../../types/env.js';
import { getAccessToken } from './auth.js';

const BASE_URL = 'https://www.strava.com/api/v3';

interface RateLimitState {
  fifteenMinUsage: number;
  fifteenMinLimit: number;
  dailyUsage: number;
  dailyLimit: number;
}

export interface StravaActivity {
  id: number;
  name: string;
  type: string;
  sport_type: string;
  workout_type: number | null;
  distance: number;
  moving_time: number;
  elapsed_time: number;
  total_elevation_gain: number;
  start_date: string;
  start_date_local: string;
  timezone: string;
  start_latlng: [number, number] | null;
  end_latlng: [number, number] | null;
  location_city: string | null;
  location_state: string | null;
  location_country: string | null;
  average_speed: number;
  max_speed: number;
  average_heartrate: number | null;
  max_heartrate: number | null;
  average_cadence: number | null;
  calories: number | null;
  suffer_score: number | null;
  map: { summary_polyline: string | null; polyline: string | null } | null;
  gear_id: string | null;
  achievement_count: number;
  pr_count: number;
  best_efforts?: StravaBestEffort[];
  splits_standard?: StravaSplit[];
  laps?: StravaLap[];
}

export interface StravaBestEffort {
  name: string;
  distance: number;
  elapsed_time: number;
  moving_time: number;
  start_date: string;
  pr_rank: number | null;
}

export interface StravaSplit {
  distance: number;
  elapsed_time: number;
  moving_time: number;
  elevation_difference: number;
  average_speed: number;
  average_heartrate: number | null;
  average_grade_adjusted_speed: number | null;
  split: number;
}

export interface StravaLap {
  id: number;
  name: string;
  distance: number;
  elapsed_time: number;
  moving_time: number;
  start_date: string;
  total_elevation_gain: number;
  average_speed: number;
  max_speed: number;
  average_heartrate: number | null;
  max_heartrate: number | null;
  lap_index: number;
  split: number;
}

export interface StravaAthleteStats {
  all_run_totals: {
    count: number;
    distance: number;
    moving_time: number;
    elapsed_time: number;
    elevation_gain: number;
  };
  ytd_run_totals: {
    count: number;
    distance: number;
    moving_time: number;
    elapsed_time: number;
    elevation_gain: number;
  };
  recent_run_totals: {
    count: number;
    distance: number;
    moving_time: number;
    elapsed_time: number;
    elevation_gain: number;
  };
}

export interface StravaGearDetail {
  id: string;
  name: string;
  brand_name: string | null;
  model_name: string | null;
  distance: number;
  retired: boolean;
}

export class StravaClient {
  private env: Env;
  private db: Database;
  private rateLimitState: RateLimitState = {
    fifteenMinUsage: 0,
    fifteenMinLimit: 200,
    dailyUsage: 0,
    dailyLimit: 2000,
  };

  constructor(env: Env, db: Database) {
    this.env = env;
    this.db = db;
  }

  private parseRateLimitHeaders(headers: Headers): void {
    const limitHeader = headers.get('X-RateLimit-Limit');
    const usageHeader = headers.get('X-RateLimit-Usage');

    if (limitHeader) {
      const [fifteenMin, daily] = limitHeader.split(',').map(Number);
      this.rateLimitState.fifteenMinLimit = fifteenMin;
      this.rateLimitState.dailyLimit = daily;
    }

    if (usageHeader) {
      const [fifteenMin, daily] = usageHeader.split(',').map(Number);
      this.rateLimitState.fifteenMinUsage = fifteenMin;
      this.rateLimitState.dailyUsage = daily;
    }
  }

  getRateLimitState(): RateLimitState {
    return { ...this.rateLimitState };
  }

  isRateLimited(): boolean {
    return (
      this.rateLimitState.fifteenMinUsage >=
        this.rateLimitState.fifteenMinLimit ||
      this.rateLimitState.dailyUsage >= this.rateLimitState.dailyLimit
    );
  }

  private async request<T>(path: string, params?: URLSearchParams): Promise<T> {
    if (this.isRateLimited()) {
      throw new Error(
        `[ERROR] Strava rate limit reached: ${this.rateLimitState.fifteenMinUsage}/${this.rateLimitState.fifteenMinLimit} (15min), ${this.rateLimitState.dailyUsage}/${this.rateLimitState.dailyLimit} (daily)`
      );
    }

    const accessToken = await getAccessToken(this.env, this.db);
    const url = new URL(`${BASE_URL}${path}`);
    if (params) {
      params.forEach((value, key) => url.searchParams.set(key, value));
    }

    const response = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    this.parseRateLimitHeaders(response.headers);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `[ERROR] Strava API ${path} failed (${response.status}): ${errorText}`
      );
    }

    return response.json() as Promise<T>;
  }

  /**
   * Fetch athlete activities with pagination.
   */
  async getActivities(options?: {
    after?: number;
    before?: number;
    page?: number;
    perPage?: number;
  }): Promise<StravaActivity[]> {
    const params = new URLSearchParams();
    if (options?.after) params.set('after', String(options.after));
    if (options?.before) params.set('before', String(options.before));
    params.set('page', String(options?.page ?? 1));
    params.set('per_page', String(options?.perPage ?? 200));

    return this.request<StravaActivity[]>('/athlete/activities', params);
  }

  /**
   * Fetch a single activity with full detail (including best_efforts).
   */
  async getActivity(id: number): Promise<StravaActivity> {
    const params = new URLSearchParams();
    params.set('include_all_efforts', 'true');
    return this.request<StravaActivity>(`/activities/${id}`, params);
  }

  /**
   * Fetch laps for an activity.
   */
  async getActivityLaps(id: number): Promise<StravaLap[]> {
    return this.request<StravaLap[]>(`/activities/${id}/laps`);
  }

  /**
   * Fetch athlete stats.
   */
  async getAthleteStats(): Promise<StravaAthleteStats> {
    return this.request<StravaAthleteStats>('/athletes/0/stats');
  }

  /**
   * Fetch gear detail.
   */
  async getGear(gearId: string): Promise<StravaGearDetail> {
    return this.request<StravaGearDetail>(`/gear/${gearId}`);
  }
}
