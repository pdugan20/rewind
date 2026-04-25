// Common shape for matched sports games. The MLB and ESPN clients
// produce records of this shape so the loader doesn't care which
// league produced which row. Stored on attended_events.event_data
// as JSON (alongside league-specific extras).

export interface SportsGameMatch {
  external_id: string; // gamePk for MLB; events[].id for ESPN
  external_source: 'mlb_stats_api' | 'espn';
  league: SportsLeague;
  season: number;
  game_type: string; // 'R' (regular), 'P' (postseason), 'S' (spring), etc.
  game_date: string; // YYYY-MM-DD in venue local time
  game_datetime_utc: string; // ISO 8601 with offset
  status: string; // 'Final', 'Scheduled', 'Live', etc.
  home_team: TeamRef;
  away_team: TeamRef;
  home_score: number | null;
  away_score: number | null;
  home_is_winner: boolean | null;
  away_is_winner: boolean | null;
}

export type SportsLeague =
  | 'mlb'
  | 'nfl'
  | 'nba'
  | 'wnba'
  | 'mls'
  | 'ncaaf'
  | 'ncaab';

export interface TeamRef {
  id: number;
  name: string;
  abbreviation?: string;
}

/**
 * Given a SportsGameMatch and the user's "side" (home or away — derived
 * from venue match), return convenience flags for storage on event_data.
 */
export function applyMyTeamPerspective(
  game: SportsGameMatch,
  myTeamSide: 'home' | 'away'
): {
  my_team: 'home' | 'away';
  my_team_won: boolean | null;
  my_team_score: number | null;
  opponent_score: number | null;
} {
  const myWinner =
    myTeamSide === 'home' ? game.home_is_winner : game.away_is_winner;
  const myScore = myTeamSide === 'home' ? game.home_score : game.away_score;
  const oppScore = myTeamSide === 'home' ? game.away_score : game.home_score;
  return {
    my_team: myTeamSide,
    my_team_won: myWinner,
    my_team_score: myScore,
    opponent_score: oppScore,
  };
}
