import { useState, type CSSProperties } from 'react';
import { thumbhashToDataUrl } from '../lib/thumbhash.js';

type Image = {
  cdn_url?: string | null;
  url?: string | null;
  thumbhash?: string | null;
  dominant_color?: string | null;
  accent_color?: string | null;
} | null;

export type Team = {
  id: number;
  name: string;
  abbreviation: string;
  league: 'mlb';
  primary_color: string | null;
  logo: Image;
};

export type PlayerMeta = {
  id: number;
  mlb_stats_id: number | null;
  full_name: string;
  primary_position: string | null;
  primary_number: string | null;
  bats: string | null;
  throws: string | null;
  debut_date: string | null;
  birth_country: string | null;
  photo_silo: Image;
  photo_full: Image;
  league: string;
  team: Team | null;
};

export type HitterStats = {
  games_played?: number;
  pa?: number;
  ab?: number;
  r?: number;
  h?: number;
  doubles?: number;
  triples?: number;
  hr?: number;
  rbi?: number;
  bb?: number;
  k?: number;
  sb?: number;
  avg?: string | null;
  obp?: string | null;
  slg?: string | null;
  ops?: string | null;
};

export type PitcherStats = {
  games_played?: number;
  games_started?: number;
  ip?: string;
  bf?: number;
  h?: number;
  r?: number;
  er?: number;
  bb?: number;
  k?: number;
  hr?: number;
  era?: string | null;
  whip?: string | null;
  decisions?: { w: number; l: number; sv: number; hld: number; bs: number };
};

export type SeasonStats = {
  season: number;
  fetched_at: string;
  cache_hit: boolean;
  hitter: HitterStats | null;
  pitcher: PitcherStats | null;
} | null;

export type AttendedSummary = {
  games_attended: number;
  games_with_box_score: number;
  wins: number;
  losses: number;
  hitter: (HitterStats & { pa: number; ab: number; h: number }) | null;
  pitcher: (PitcherStats & { ip: string; bf: number }) | null;
};

export type AttendedAppearance = {
  event_id: number;
  event_date: string;
  title: string;
  is_home: boolean;
  batting_line: Record<string, unknown> | null;
  pitching_line: Record<string, unknown> | null;
  decision: 'W' | 'L' | 'SV' | 'HLD' | 'BS' | null;
  notable: boolean;
  notable_reasons: string[];
};

export type AthletePayload = {
  player: PlayerMeta;
  supported: boolean;
  season_stats: SeasonStats;
  attended_summary: AttendedSummary;
  attended_appearances: AttendedAppearance[];
  attended_appearance_count: number;
};

const HEAD_PX = 120;
const HEAD_TRANSFORM = `width=${HEAD_PX * 2},height=${HEAD_PX * 2},fit=cover,format=auto,quality=85`;
const LOGO_PX = 40;
const LOGO_TRANSFORM = `width=${LOGO_PX * 2},height=${LOGO_PX * 2},fit=contain,format=auto,quality=85`;

function buildSrc(
  image: Image,
  transform: string
): { src: string; placeholder: string | null } | null {
  if (!image) return null;
  const base = image.cdn_url ?? image.url ?? null;
  if (!base) return null;
  const transformed = base.includes('?')
    ? `${base.split('?')[0]}?${transform}`
    : `${base}?${transform}`;
  return {
    src: transformed,
    placeholder: thumbhashToDataUrl(image.thumbhash ?? null),
  };
}

function fmt(n: number | null | undefined): string {
  if (n === null || n === undefined) return '0';
  return n.toLocaleString();
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export function AthleteDetail({
  payload,
  onOpen: _onOpen,
}: {
  payload: AthletePayload;
  onOpen?: (url: string) => void;
}) {
  const {
    player,
    supported,
    season_stats,
    attended_summary,
    attended_appearances,
    attended_appearance_count,
  } = payload;
  const teamColor = player.team?.primary_color ?? null;
  const accentColor = teamColor ?? 'var(--color-accent, #4c6ef5)';

  return (
    <article style={cardStyle}>
      <Hero player={player} accentColor={accentColor} />

      {!supported && (
        <div style={unsupportedNoteStyle}>
          Live stats unavailable for {player.league.toUpperCase()} players in
          v1. See your attended appearances below.
        </div>
      )}

      <div style={statsGridStyle}>
        <SeasonStatsBlock
          season_stats={season_stats}
          accentColor={accentColor}
        />
        <AttendedSummaryBlock
          summary={attended_summary}
          accentColor={accentColor}
        />
      </div>

      {attended_appearances.length > 0 && (
        <NotableHighlights appearances={attended_appearances} />
      )}

      {attended_appearances.length > 0 && (
        <RecentAppearances
          appearances={attended_appearances}
          totalCount={attended_appearance_count}
          accentColor={accentColor}
        />
      )}
    </article>
  );
}

function Hero({
  player,
  accentColor,
}: {
  player: PlayerMeta;
  accentColor: string;
}) {
  const head = buildSrc(player.photo_full ?? player.photo_silo, HEAD_TRANSFORM);
  const logo = buildSrc(player.team?.logo ?? null, LOGO_TRANSFORM);
  const [headLoaded, setHeadLoaded] = useState(false);
  const [logoLoaded, setLogoLoaded] = useState(false);

  return (
    <div style={heroStyle}>
      <div
        style={{
          ...portraitStyle,
          background: head
            ? 'rgba(127,127,127,0.10)'
            : `linear-gradient(135deg, ${accentColor} 0%, rgba(0,0,0,0.4) 100%)`,
        }}
        aria-hidden
      >
        {head && head.placeholder && (
          <img
            src={head.placeholder}
            alt=""
            aria-hidden
            style={{
              ...portraitImgStyle,
              filter: 'blur(12px)',
              transform: 'scale(1.05)',
              opacity: headLoaded ? 0 : 1,
              transition: 'opacity 200ms ease',
            }}
          />
        )}
        {head && (
          <img
            src={head.src}
            alt={player.full_name}
            loading="lazy"
            onLoad={() => setHeadLoaded(true)}
            style={{
              ...portraitImgStyle,
              opacity: headLoaded ? 1 : 0,
              transition: 'opacity 240ms ease',
            }}
          />
        )}
      </div>
      <div style={heroTextColStyle}>
        <h1 style={titleStyle}>{player.full_name}</h1>
        <div style={badgeRowStyle}>
          {logo && (
            <span style={logoBadgeStyle}>
              <img
                src={logo.src}
                alt={player.team?.abbreviation ?? ''}
                loading="lazy"
                onLoad={() => setLogoLoaded(true)}
                style={{
                  width: LOGO_PX,
                  height: LOGO_PX,
                  objectFit: 'contain',
                  display: 'block',
                  opacity: logoLoaded ? 1 : 0,
                  transition: 'opacity 200ms ease',
                }}
              />
            </span>
          )}
          {player.team && (
            <span style={teamNameStyle}>{player.team.abbreviation}</span>
          )}
          {player.primary_position && (
            <span style={positionPillStyle}>{player.primary_position}</span>
          )}
          {player.primary_number && (
            <span style={numberStyle}>#{player.primary_number}</span>
          )}
        </div>
        <div style={bioRowStyle}>
          {(player.bats || player.throws) && (
            <span>
              Bats {player.bats ?? '?'} / Throws {player.throws ?? '?'}
            </span>
          )}
          {player.debut_date && (
            <span>Debut {formatDate(player.debut_date)}</span>
          )}
          {player.birth_country && <span>{player.birth_country}</span>}
        </div>
      </div>
    </div>
  );
}

function SeasonStatsBlock({
  season_stats,
  accentColor,
}: {
  season_stats: SeasonStats;
  accentColor: string;
}) {
  if (!season_stats || (!season_stats.hitter && !season_stats.pitcher)) {
    return (
      <div style={statsBlockStyle}>
        <h2 style={statsBlockHeadingStyle}>This season</h2>
        <div style={statsUnavailableStyle}>Season stats unavailable</div>
      </div>
    );
  }

  if (season_stats.hitter) {
    const h = season_stats.hitter;
    return (
      <div style={statsBlockStyle}>
        <h2 style={statsBlockHeadingStyle}>
          {season_stats.season} season
          <CacheDot cache_hit={season_stats.cache_hit} />
        </h2>
        <SlashLine
          avg={h.avg ?? '.000'}
          obp={h.obp ?? '.000'}
          slg={h.slg ?? '.000'}
          accentColor={accentColor}
        />
        <div style={countingRowStyle}>
          <CountingStat label="HR" value={fmt(h.hr)} />
          <CountingStat label="RBI" value={fmt(h.rbi)} />
          <CountingStat label="R" value={fmt(h.r)} />
          <CountingStat label="SB" value={fmt(h.sb)} />
          <CountingStat label="G" value={fmt(h.games_played)} />
        </div>
      </div>
    );
  }

  const p = season_stats.pitcher!;
  return (
    <div style={statsBlockStyle}>
      <h2 style={statsBlockHeadingStyle}>
        {season_stats.season} season
        <CacheDot cache_hit={season_stats.cache_hit} />
      </h2>
      <div style={pitcherTopRowStyle}>
        <div>
          <div style={{ ...slashValueStyle, color: accentColor }}>
            {p.era ?? '0.00'}
          </div>
          <div style={slashLabelStyle}>ERA</div>
        </div>
        <div>
          <div style={{ ...slashValueStyle, color: accentColor }}>
            {p.whip ?? '0.00'}
          </div>
          <div style={slashLabelStyle}>WHIP</div>
        </div>
      </div>
      <div style={countingRowStyle}>
        {p.decisions && (
          <CountingStat
            label="W-L"
            value={`${p.decisions.w}-${p.decisions.l}`}
          />
        )}
        <CountingStat label="K" value={fmt(p.k)} />
        <CountingStat label="IP" value={p.ip ?? '0.0'} />
        <CountingStat label="GS" value={fmt(p.games_started)} />
      </div>
    </div>
  );
}

function AttendedSummaryBlock({
  summary,
  accentColor,
}: {
  summary: AttendedSummary;
  accentColor: string;
}) {
  return (
    <div style={statsBlockStyle}>
      <h2 style={statsBlockHeadingStyle}>
        In games you attended
        <span style={attendedCountStyle}>{summary.games_attended}</span>
      </h2>
      {summary.hitter ? (
        <>
          {summary.hitter.avg !== null && summary.hitter.avg !== undefined && (
            <SlashLine
              avg={summary.hitter.avg ?? '.000'}
              obp={null}
              slg={summary.hitter.slg ?? '.000'}
              accentColor={accentColor}
            />
          )}
          <div style={countingRowStyle}>
            <CountingStat
              label="H/AB"
              value={`${summary.hitter.h}/${summary.hitter.ab}`}
            />
            <CountingStat label="HR" value={fmt(summary.hitter.hr)} />
            <CountingStat label="RBI" value={fmt(summary.hitter.rbi)} />
            <CountingStat label="BB" value={fmt(summary.hitter.bb)} />
            <CountingStat label="K" value={fmt(summary.hitter.k)} />
          </div>
        </>
      ) : summary.pitcher ? (
        <>
          <div style={pitcherTopRowStyle}>
            <div>
              <div style={{ ...slashValueStyle, color: accentColor }}>
                {summary.pitcher.era ?? '0.00'}
              </div>
              <div style={slashLabelStyle}>ERA</div>
            </div>
            <div>
              <div style={{ ...slashValueStyle, color: accentColor }}>
                {summary.pitcher.whip ?? '0.00'}
              </div>
              <div style={slashLabelStyle}>WHIP</div>
            </div>
          </div>
          <div style={countingRowStyle}>
            {summary.pitcher.decisions && (
              <CountingStat
                label="W-L-SV"
                value={`${summary.pitcher.decisions.w}-${summary.pitcher.decisions.l}-${summary.pitcher.decisions.sv}`}
              />
            )}
            <CountingStat label="K" value={fmt(summary.pitcher.k)} />
            <CountingStat label="IP" value={summary.pitcher.ip} />
            <CountingStat label="BF" value={fmt(summary.pitcher.bf)} />
          </div>
        </>
      ) : (
        <div style={statsUnavailableStyle}>
          {summary.games_attended > 0
            ? 'No box-score data for these games'
            : 'No attended appearances'}
        </div>
      )}
      {summary.games_with_box_score > 0 &&
        summary.games_with_box_score < summary.games_attended && (
          <div style={coverageNoteStyle}>
            {summary.games_with_box_score} of {summary.games_attended} games
            have box-score data
          </div>
        )}
    </div>
  );
}

function SlashLine({
  avg,
  obp,
  slg,
  accentColor,
}: {
  avg: string;
  obp: string | null;
  slg: string;
  accentColor: string;
}) {
  return (
    <div style={slashLineRowStyle}>
      <div>
        <div style={{ ...slashValueStyle, color: accentColor }}>{avg}</div>
        <div style={slashLabelStyle}>AVG</div>
      </div>
      {obp !== null && (
        <div>
          <div style={{ ...slashValueStyle, color: accentColor }}>{obp}</div>
          <div style={slashLabelStyle}>OBP</div>
        </div>
      )}
      <div>
        <div style={{ ...slashValueStyle, color: accentColor }}>{slg}</div>
        <div style={slashLabelStyle}>SLG</div>
      </div>
    </div>
  );
}

function CountingStat({ label, value }: { label: string; value: string }) {
  return (
    <div style={countingTileStyle}>
      <div style={countingValueStyle}>{value}</div>
      <div style={countingLabelStyle}>{label}</div>
    </div>
  );
}

function CacheDot({ cache_hit }: { cache_hit: boolean }) {
  return (
    <span
      title={cache_hit ? 'Cached (≤1h)' : 'Live fetch'}
      style={{
        ...cacheDotStyle,
        background: cache_hit ? 'rgba(127,127,127,0.4)' : 'rgb(46, 160, 67)',
      }}
      aria-hidden
    />
  );
}

function NotableHighlights({
  appearances,
}: {
  appearances: AttendedAppearance[];
}) {
  // Aggregate notable_reasons across all appearances; count duplicates.
  const counts = new Map<string, number>();
  for (const a of appearances) {
    for (const r of a.notable_reasons ?? []) {
      // Normalize "1 HR", "2 HR" → "HR" so they aggregate.
      const key = r.replace(/^\d+\s+/, '').trim();
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  if (counts.size === 0) return null;

  const sorted = [...counts.entries()]
    .filter(([key]) => key.length > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6);

  return (
    <section style={sectionStyle}>
      <h2 style={sectionHeadingStyle}>You saw live</h2>
      <div style={notableRowStyle}>
        {sorted.map(([key, count]) => (
          <span key={key} style={notableChipStyle}>
            {count > 1 ? `${count} ${key}` : key}
          </span>
        ))}
      </div>
    </section>
  );
}

function RecentAppearances({
  appearances,
  totalCount,
  accentColor: _accentColor,
}: {
  appearances: AttendedAppearance[];
  totalCount: number;
  accentColor: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? appearances : appearances.slice(0, 5);
  const more = appearances.length - visible.length;

  return (
    <section style={sectionStyle}>
      <h2 style={sectionHeadingStyle}>Recent appearances</h2>
      <ol style={appearancesListStyle}>
        {visible.map((a) => (
          <li key={a.event_id} style={appearanceRowStyle}>
            <div style={appearanceDateStyle}>{formatDate(a.event_date)}</div>
            <div style={appearanceMainColStyle}>
              <div style={appearanceTitleStyle}>{a.title}</div>
              <div style={appearanceStatStyle}>{appearanceStatLine(a)}</div>
            </div>
            <div style={appearanceBadgesStyle}>
              {a.decision && (
                <span style={decisionBadgeStyle}>{a.decision}</span>
              )}
              {a.notable && (
                <span style={notableDotStyle} aria-label="notable" />
              )}
            </div>
          </li>
        ))}
      </ol>
      {more > 0 && !expanded && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          style={showMoreStyle}
        >
          Show all ({totalCount} total)
        </button>
      )}
    </section>
  );
}

function appearanceStatLine(a: AttendedAppearance): string {
  const parts: string[] = [];
  if (a.batting_line) {
    const b = a.batting_line as {
      ab?: number;
      h?: number;
      hr?: number;
      rbi?: number;
    };
    parts.push(`${b.h ?? 0}-${b.ab ?? 0}`);
    if (b.hr) parts.push(`${b.hr} HR`);
    if (b.rbi) parts.push(`${b.rbi} RBI`);
  }
  if (a.pitching_line) {
    const p = a.pitching_line as { ip?: string; k?: number; er?: number };
    parts.push(`${p.ip ?? '0.0'} IP, ${p.k ?? 0} K, ${p.er ?? 0} ER`);
  }
  return parts.join(' · ') || '—';
}

const cardStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 16,
  maxWidth: 720,
  margin: '0 auto',
  padding: '20px 22px 22px',
  borderRadius: 12,
  border: '1px solid var(--color-border-tertiary, rgba(127,127,127,0.12))',
  background: 'var(--color-background-primary, transparent)',
};

const heroStyle: CSSProperties = {
  display: 'flex',
  gap: 18,
  alignItems: 'flex-start',
};

const portraitStyle: CSSProperties = {
  width: HEAD_PX,
  height: HEAD_PX,
  borderRadius: 12,
  flexShrink: 0,
  position: 'relative',
  overflow: 'hidden',
};

const portraitImgStyle: CSSProperties = {
  position: 'absolute',
  inset: 0,
  width: '100%',
  height: '100%',
  objectFit: 'cover',
};

const heroTextColStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
};

const titleStyle: CSSProperties = {
  fontSize: 24,
  fontWeight: 700,
  margin: 0,
  lineHeight: 1.15,
  color: 'var(--color-text-primary, inherit)',
};

const badgeRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  flexWrap: 'wrap',
};

const logoBadgeStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: LOGO_PX,
  height: LOGO_PX,
  borderRadius: 6,
  background: 'rgba(255,255,255,0.04)',
};

const teamNameStyle: CSSProperties = {
  fontSize: 14,
  fontWeight: 700,
  letterSpacing: 0.5,
};

const positionPillStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: 0.5,
  textTransform: 'uppercase',
  padding: '3px 8px',
  borderRadius: 999,
  background: 'rgba(127,127,127,0.18)',
};

const numberStyle: CSSProperties = {
  fontSize: 14,
  fontWeight: 600,
  opacity: 0.7,
  fontVariantNumeric: 'tabular-nums',
};

const bioRowStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 14,
  fontSize: 13,
  opacity: 0.7,
  marginTop: 2,
};

const unsupportedNoteStyle: CSSProperties = {
  padding: '10px 12px',
  borderRadius: 8,
  background: 'rgba(127,127,127,0.08)',
  fontSize: 13,
  fontStyle: 'italic',
  opacity: 0.85,
};

const statsGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
  gap: 14,
  paddingTop: 12,
  borderTop: '1px solid var(--color-border-tertiary, rgba(127,127,127,0.12))',
};

const statsBlockStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
};

const statsBlockHeadingStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  letterSpacing: 0.6,
  textTransform: 'uppercase',
  margin: 0,
  opacity: 0.65,
  display: 'flex',
  alignItems: 'center',
  gap: 8,
};

const cacheDotStyle: CSSProperties = {
  width: 6,
  height: 6,
  borderRadius: '50%',
  display: 'inline-block',
};

const attendedCountStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 500,
  background: 'rgba(127,127,127,0.15)',
  padding: '2px 7px',
  borderRadius: 999,
  letterSpacing: 0,
};

const slashLineRowStyle: CSSProperties = {
  display: 'flex',
  gap: 18,
  alignItems: 'baseline',
};

const slashValueStyle: CSSProperties = {
  fontSize: 22,
  fontWeight: 700,
  fontVariantNumeric: 'tabular-nums',
  lineHeight: 1.1,
};

const slashLabelStyle: CSSProperties = {
  fontSize: 10,
  fontWeight: 600,
  letterSpacing: 0.5,
  textTransform: 'uppercase',
  opacity: 0.55,
};

const pitcherTopRowStyle: CSSProperties = {
  display: 'flex',
  gap: 24,
  alignItems: 'baseline',
};

const countingRowStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 14,
};

const countingTileStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 0,
};

const countingValueStyle: CSSProperties = {
  fontSize: 14,
  fontWeight: 600,
  fontVariantNumeric: 'tabular-nums',
};

const countingLabelStyle: CSSProperties = {
  fontSize: 10,
  fontWeight: 500,
  letterSpacing: 0.4,
  textTransform: 'uppercase',
  opacity: 0.55,
};

const statsUnavailableStyle: CSSProperties = {
  fontSize: 13,
  opacity: 0.55,
  fontStyle: 'italic',
};

const coverageNoteStyle: CSSProperties = {
  fontSize: 11,
  opacity: 0.55,
  fontStyle: 'italic',
  marginTop: 4,
};

const sectionStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  paddingTop: 12,
  borderTop: '1px solid var(--color-border-tertiary, rgba(127,127,127,0.12))',
};

const sectionHeadingStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  letterSpacing: 0.6,
  textTransform: 'uppercase',
  margin: 0,
  opacity: 0.65,
};

const notableRowStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 8,
};

const notableChipStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  padding: '4px 10px',
  borderRadius: 999,
  background: 'rgba(76, 110, 245, 0.12)',
  color: 'var(--color-accent, #4c6ef5)',
};

const appearancesListStyle: CSSProperties = {
  margin: 0,
  padding: 0,
  listStyle: 'none',
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
};

const appearanceRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 12,
  padding: '6px 4px',
  borderRadius: 4,
};

const appearanceDateStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  width: 88,
  flexShrink: 0,
  opacity: 0.65,
  fontVariantNumeric: 'tabular-nums',
  paddingTop: 1,
};

const appearanceMainColStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 1,
};

const appearanceTitleStyle: CSSProperties = {
  fontSize: 13,
  fontWeight: 500,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const appearanceStatStyle: CSSProperties = {
  fontSize: 12,
  opacity: 0.7,
  fontVariantNumeric: 'tabular-nums',
};

const appearanceBadgesStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  flexShrink: 0,
};

const decisionBadgeStyle: CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: 0.6,
  padding: '2px 6px',
  borderRadius: 4,
  background: 'rgba(46, 160, 67, 0.18)',
  color: 'rgb(46, 160, 67)',
};

const notableDotStyle: CSSProperties = {
  width: 6,
  height: 6,
  borderRadius: '50%',
  background: 'var(--color-accent, #4c6ef5)',
  display: 'inline-block',
};

const showMoreStyle: CSSProperties = {
  alignSelf: 'flex-start',
  fontSize: 12,
  fontWeight: 500,
  border: 'none',
  background: 'transparent',
  cursor: 'pointer',
  font: 'inherit',
  color: 'var(--color-accent, #4c6ef5)',
  padding: '4px 0',
};
