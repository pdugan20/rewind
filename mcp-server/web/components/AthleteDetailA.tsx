import { useState, type CSSProperties } from 'react';
import { thumbhashToDataUrl } from '../lib/thumbhash.js';
import { TeamLogo } from './TeamLogo.js';
import { HitterStatBlock } from './HitterStatBlock.js';
import type {
  AthletePayload,
  CareerHistory,
  CareerHittingSeason,
  CareerPitchingSeason,
  PlayerAward,
  PlayerMeta,
  SeasonSplits,
} from './AthleteDetail.js';

/**
 * Variant A — "ESPN deluxe": vertical sections, encyclopedia layout.
 * Hero → bio strip → big-4 panel → counting row → splits 2x2 → in-games
 * you attended → career table → awards → recent appearances.
 *
 * Tries to match the density of an ESPN player overview while staying
 * a one-column scroll suitable for both Claude Desktop (~720px) and
 * iOS widths.
 */

const HEAD_PX = 110;
const HEAD_TX = `width=${HEAD_PX * 2},height=${HEAD_PX * 2},fit=cover,format=auto,quality=85`;

// Max rows for the long-tail sections. Each surfaces a "X total"
// trailing badge when the underlying list is longer than the cap.
const MAX_GAME_LOG_ROWS = 5;
const MAX_CAREER_ROWS = 5;
const MAX_AWARDS_ROWS = 5;

// Mirrors cardStyle's horizontal padding. Used by the tab nav and
// the soft career table to bleed past the column grid out to the
// outer card edge via negative margins.
const CARD_PADDING_X = 22;

type Image = {
  cdn_url?: string | null;
  url?: string | null;
  thumbhash?: string | null;
  dominant_color?: string | null;
  accent_color?: string | null;
} | null;

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

function ageFrom(iso: string | null): number | null {
  if (!iso) return null;
  const dob = new Date(iso);
  const now = new Date();
  let age = now.getUTCFullYear() - dob.getUTCFullYear();
  const m = now.getUTCMonth() - dob.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < dob.getUTCDate())) age -= 1;
  return age;
}

function batsLabel(code: string | null): string {
  if (!code) return '?';
  if (code === 'L') return 'Left';
  if (code === 'R') return 'Right';
  if (code === 'S' || code === 'B') return 'Switch';
  return code;
}

function birthplace(p: PlayerMeta): string | null {
  const parts = [p.birth_city, p.birth_state_province, p.birth_country];
  const trimmed = parts.filter((v) => v && v.length).join(', ');
  return trimmed.length > 0 ? trimmed : null;
}

type Tab = 'all' | 'stats' | 'game-log' | 'career';

export function AthleteDetailA({
  payload,
  onOpen: _onOpen,
}: {
  payload: AthletePayload;
  onOpen?: (url: string) => void;
}) {
  const {
    player,
    season_stats,
    career,
    splits,
    attended_summary,
    attended_appearances,
    attended_appearance_count,
  } = payload;
  const tint =
    player.primary_team?.ui_tint_color ??
    player.primary_team?.primary_color ??
    'var(--color-accent, #4c6ef5)';

  const [tab, setTab] = useState<Tab>('all');

  // Tab → section visibility. "Stats" pairs the season block with
  // splits since splits are season-scoped; "Game log" pairs the
  // attended summary with the per-game lines (the summary IS the
  // aggregate of those lines); "Career" gathers year-by-year + awards.
  const showStats = tab === 'all' || tab === 'stats';
  const showGameLog = tab === 'all' || tab === 'game-log';
  const showCareer = tab === 'all' || tab === 'career';

  return (
    <article style={cardStyle}>
      <Hero player={player} />
      <BioStrip player={player} />
      <TabNav active={tab} onChange={setTab} tint={tint} />

      {showStats &&
        (season_stats?.hitter ? (
          <HitterStatBlock
            title={`${season_stats.season ?? ''} season`}
            stats={season_stats.hitter}
            games={season_stats.hitter.games_played}
            tint={tint}
          />
        ) : season_stats?.pitcher ? (
          <section style={sectionStyle}>
            <SectionHeader>{season_stats?.season ?? '—'} season</SectionHeader>
            <BigFourPitcher
              era={season_stats.pitcher.era}
              whip={season_stats.pitcher.whip}
              k={season_stats.pitcher.k}
              ip={season_stats.pitcher.ip}
              tint={tint}
            />
          </section>
        ) : (
          <section style={sectionStyle}>
            <SectionHeader>Season</SectionHeader>
            <div style={emptyStyle}>Season stats unavailable</div>
          </section>
        ))}

      {showStats && splits && hasAnySplit(splits) && (
        <section style={sectionStyle}>
          <SectionHeader>Splits</SectionHeader>
          <SplitsGrid splits={splits} tint={tint} />
        </section>
      )}

      {showGameLog && attended_summary?.hitter && (
        <HitterStatBlock
          title="In games you attended"
          trailing={`${attended_summary.games_attended} games`}
          stats={attended_summary.hitter}
          games={attended_summary.games_attended}
          tint={tint}
        />
      )}

      {showGameLog && attended_appearances.length > 0 && (
        <section style={sectionStyle}>
          <SectionHeader
            trailing={
              attended_appearance_count > MAX_GAME_LOG_ROWS
                ? `${attended_appearance_count} total`
                : undefined
            }
          >
            Game log
          </SectionHeader>
          <RecentAppearancesList
            appearances={attended_appearances.slice(0, MAX_GAME_LOG_ROWS)}
            tint={tint}
          />
        </section>
      )}

      {showCareer && career && career.seasons.length > 0 && (
        <section style={sectionStyle}>
          <SectionHeader
            trailing={
              career.seasons.length > MAX_CAREER_ROWS
                ? `${career.seasons.length} seasons`
                : undefined
            }
          >
            Career
          </SectionHeader>
          <CareerTable career={career} tint={tint} maxRows={MAX_CAREER_ROWS} />
        </section>
      )}

      {showCareer && player.awards && player.awards.length > 0 && (
        <section style={sectionStyle}>
          <SectionHeader
            trailing={
              player.awards.length > MAX_AWARDS_ROWS
                ? `${player.awards.length} total`
                : undefined
            }
          >
            Career highlights
          </SectionHeader>
          <AwardsList
            awards={player.awards.slice(0, MAX_AWARDS_ROWS)}
            tint={tint}
          />
        </section>
      )}
    </article>
  );
}

function TabNav({
  active,
  onChange,
  tint,
}: {
  active: Tab;
  onChange: (t: Tab) => void;
  tint: string;
}) {
  const tabs: Array<[Tab, string]> = [
    ['all', 'All'],
    ['stats', 'Stats'],
    ['game-log', 'Game log'],
    ['career', 'Career'],
  ];
  return (
    <nav style={tabNavStyle}>
      {tabs.map(([id, label]) => {
        const isActive = id === active;
        return (
          <button
            key={id}
            type="button"
            onClick={() => onChange(id)}
            style={{
              ...tabButtonStyle,
              color: isActive ? tint : 'inherit',
              opacity: isActive ? 1 : 0.55,
              borderBottomColor: isActive ? tint : 'transparent',
            }}
          >
            {label}
          </button>
        );
      })}
    </nav>
  );
}

function Hero({ player }: { player: PlayerMeta }) {
  const head = buildSrc(player.photo_full ?? player.photo_silo, HEAD_TX);
  const [headLoaded, setHeadLoaded] = useState(false);
  return (
    <div style={heroStyle}>
      <div style={portraitStyle} aria-hidden>
        {head?.placeholder && (
          <img
            src={head.placeholder}
            alt=""
            aria-hidden
            style={{
              ...portraitImgStyle,
              filter: 'blur(12px)',
              transform: 'scale(1.05)',
              opacity: headLoaded ? 0 : 1,
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
      <div style={heroRightStyle}>
        <h1 style={titleStyle}>{player.full_name}</h1>
        <div style={badgeRowStyle}>
          {player.primary_team && (
            <span style={teamBadgeStyle}>
              <TeamLogo
                team={player.primary_team}
                size={20}
                variant="default"
              />
              <span style={teamAbbrStyle}>
                {player.primary_team.abbreviation}
              </span>
            </span>
          )}
          {player.primary_position && (
            <span style={chipStyle}>{player.primary_position}</span>
          )}
          {player.primary_number && (
            <span style={numberStyle}>#{player.primary_number}</span>
          )}
        </div>
      </div>
    </div>
  );
}

function BioStrip({ player }: { player: PlayerMeta }) {
  const age = ageFrom(player.birth_date);
  const items: Array<[string, string]> = [];
  if (player.height || player.weight) {
    const ht = player.height ?? '';
    const wt = player.weight ? `, ${player.weight} lbs` : '';
    items.push(['HT/WT', `${ht}${wt}`.trim()]);
  }
  if (player.bats || player.throws) {
    items.push([
      'BAT/THR',
      `${batsLabel(player.bats)}/${batsLabel(player.throws)}`,
    ]);
  }
  if (player.birth_date) {
    const dt = new Date(player.birth_date).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
    items.push(['BORN', `${dt}${age != null ? ` (${age})` : ''}`]);
  }
  const place = birthplace(player);
  if (place) items.push(['FROM', place]);
  if (player.debut_date) {
    items.push([
      'DEBUT',
      new Date(player.debut_date).getUTCFullYear().toString(),
    ]);
  }
  if (player.college_name) items.push(['COLLEGE', player.college_name]);
  if (items.length === 0) return null;
  return (
    <dl style={bioStripStyle}>
      {items.map(([k, v]) => (
        <div key={k} style={bioPairStyle}>
          <dt style={bioKeyStyle}>{k}</dt>
          <dd style={bioValueStyle}>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function BigFourPitcher({
  era,
  whip,
  k,
  ip,
  tint,
}: {
  era: string | null | undefined;
  whip: string | null | undefined;
  k: number | null | undefined;
  ip: string | null | undefined;
  tint: string;
}) {
  const cells: Array<[string, string]> = [];
  if (era) cells.push(['ERA', era]);
  if (whip) cells.push(['WHIP', whip]);
  if (k != null) cells.push(['K', fmt(k)]);
  if (ip) cells.push(['IP', ip]);
  if (cells.length === 0) return null;
  return (
    <div style={bigFourStyle}>
      {cells.map(([key, v]) => (
        <div key={key} style={bigFourCellStyle}>
          <div style={{ ...bigFourValueStyle, color: tint }}>{v}</div>
          <div style={bigFourLabelStyle}>{key}</div>
        </div>
      ))}
    </div>
  );
}

function hasAnySplit(s: SeasonSplits): boolean {
  if (!s) return false;
  return !!(s.home || s.away || s.vs_left || s.vs_right);
}

function SplitsGrid({
  splits,
  tint,
}: {
  splits: NonNullable<SeasonSplits>;
  tint: string;
}) {
  const items: Array<[string, typeof splits.home]> = [
    ['Home', splits.home],
    ['Away', splits.away],
    ['vs LHP', splits.vs_left],
    ['vs RHP', splits.vs_right],
  ];
  return (
    <div style={splitsGridStyle}>
      {items.map(([label, s]) =>
        s ? (
          <div key={label} style={splitCellStyle}>
            <div style={splitLabelStyle}>{label}</div>
            <div style={{ ...splitValueStyle, color: tint }}>
              {s.avg ?? '—'}
            </div>
            <div style={splitSubStyle}>
              {s.hr ?? 0} HR · {s.rbi ?? 0} RBI · {s.ops ?? '—'} OPS
            </div>
          </div>
        ) : null
      )}
    </div>
  );
}

function CareerTable({
  career,
  tint,
  maxRows,
}: {
  career: NonNullable<CareerHistory>;
  tint: string;
  maxRows?: number;
}) {
  const isHitter = career.group === 'hitting';
  const sorted = (
    isHitter
      ? (career.seasons as CareerHittingSeason[])
      : (career.seasons as CareerPitchingSeason[])
  )
    .slice()
    .reverse(); // newest first
  const seasons =
    maxRows != null && sorted.length > maxRows
      ? sorted.slice(0, maxRows)
      : sorted;

  // No outer container; alt-row stripes bleed to the outer card edge
  // via negative horizontal margins. First/last cells carry the bleed
  // offset back as padding so column text stays left-aligned with the
  // section header.
  if (isHitter) {
    return (
      <div style={tableBleedStyle}>
        <table style={tableStyleSoft}>
          <thead>
            <tr>
              <th style={thFirstStyleSoft}>Year</th>
              <th style={thStyleSoft}>Team</th>
              <th style={thRightStyleSoft}>G</th>
              <th style={thRightStyleSoft}>AB</th>
              <th style={thRightStyleSoft}>HR</th>
              <th style={thRightStyleSoft}>RBI</th>
              <th style={thRightStyleSoft}>AVG</th>
              <th style={thLastRightStyleSoft}>OPS</th>
            </tr>
          </thead>
          <tbody>
            {(seasons as CareerHittingSeason[]).map((s, i) => (
              <tr
                key={`${s.season}-${s.team_id ?? i}`}
                style={i % 2 === 1 ? trStripeStyle : undefined}
              >
                <td style={tdFirstStyleSoft}>{s.season}</td>
                <td style={tdStyleSoft}>{abbreviateTeam(s.team_name)}</td>
                <td style={tdRightStyleSoft}>{fmt(s.games_played)}</td>
                <td style={tdRightStyleSoft}>{fmt(s.ab)}</td>
                <td style={{ ...tdRightStyleSoft, fontWeight: 600 }}>
                  {fmt(s.hr)}
                </td>
                <td style={tdRightStyleSoft}>{fmt(s.rbi)}</td>
                <td
                  style={{
                    ...tdRightStyleSoft,
                    color: tint,
                    fontWeight: 600,
                  }}
                >
                  {s.avg ?? '—'}
                </td>
                <td style={tdLastRightStyleSoft}>{s.ops ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  return (
    <div style={tableBleedStyle}>
      <table style={tableStyleSoft}>
        <thead>
          <tr>
            <th style={thFirstStyleSoft}>Year</th>
            <th style={thStyleSoft}>Team</th>
            <th style={thRightStyleSoft}>G</th>
            <th style={thRightStyleSoft}>IP</th>
            <th style={thRightStyleSoft}>K</th>
            <th style={thRightStyleSoft}>W-L</th>
            <th style={thRightStyleSoft}>ERA</th>
            <th style={thLastRightStyleSoft}>WHIP</th>
          </tr>
        </thead>
        <tbody>
          {(seasons as CareerPitchingSeason[]).map((s, i) => (
            <tr
              key={`${s.season}-${s.team_id ?? i}`}
              style={i % 2 === 1 ? trStripeStyle : undefined}
            >
              <td style={tdFirstStyleSoft}>{s.season}</td>
              <td style={tdStyleSoft}>{abbreviateTeam(s.team_name)}</td>
              <td style={tdRightStyleSoft}>{fmt(s.games_played)}</td>
              <td style={tdRightStyleSoft}>{s.ip ?? '—'}</td>
              <td style={tdRightStyleSoft}>{fmt(s.k)}</td>
              <td style={tdRightStyleSoft}>
                {fmt(s.wins)}-{fmt(s.losses)}
              </td>
              <td
                style={{
                  ...tdRightStyleSoft,
                  color: tint,
                  fontWeight: 600,
                }}
              >
                {s.era ?? '—'}
              </td>
              <td style={tdLastRightStyleSoft}>{s.whip ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function abbreviateTeam(name: string | null): string {
  if (!name) return '—';
  // Use last word as a quick abbreviation when full team name overflows.
  return name.length > 14 ? name.split(/\s+/).slice(-1)[0] : name;
}

function AwardsList({ awards, tint }: { awards: PlayerAward[]; tint: string }) {
  return (
    <ul style={awardsListStyle}>
      {awards.map((a, i) => (
        <li key={`${a.season}-${a.id}-${i}`} style={awardRowStyle}>
          <span style={{ ...awardDotStyle, background: tint }} />
          <span style={awardNameStyle}>{a.name}</span>
          <span style={awardSeasonStyle}>{a.season}</span>
        </li>
      ))}
    </ul>
  );
}

function RecentAppearancesList({
  appearances,
  tint,
}: {
  appearances: AthletePayload['attended_appearances'];
  tint: string;
}) {
  return (
    <ul style={appearancesStyle}>
      {appearances.map((a, i) => (
        <li
          key={a.event_id}
          style={i === 0 ? appearanceRowFirstStyle : appearanceRowStyle}
        >
          <div style={appearanceHeaderStyle}>
            <span style={appearanceTitleStyle}>{a.title}</span>
            <span style={appearanceDateStyle}>
              {formatDateShort(a.event_date)}
            </span>
          </div>
          <div style={appearanceStatRowStyle}>
            <span style={appearanceStatStyle}>{summarizeStatLine(a)}</span>
            {a.notable && (
              <span style={{ ...notableDotStyle, background: tint }} />
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

function summarizeStatLine(
  a: AthletePayload['attended_appearances'][number]
): string {
  const b = a.batting_line as Record<string, unknown> | null;
  const p = a.pitching_line as Record<string, unknown> | null;
  if (b && b.ab) {
    const parts = [
      `${b.h ?? 0}-${b.ab}`,
      b.hr ? `${b.hr} HR` : null,
      b.rbi ? `${b.rbi} RBI` : null,
      b.bb ? `${b.bb} BB` : null,
    ].filter(Boolean);
    return parts.join(' · ');
  }
  if (p && p.ip) {
    const parts = [
      `${p.ip} IP`,
      p.er != null ? `${p.er} ER` : null,
      p.k ? `${p.k} K` : null,
      p.bb != null ? `${p.bb} BB` : null,
    ].filter(Boolean);
    return parts.join(' · ');
  }
  return '—';
}

function formatDateShort(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function SectionHeader({
  children,
  trailing,
}: {
  children: React.ReactNode;
  trailing?: string;
}) {
  return (
    <div style={sectionHeaderStyle}>
      <span>{children}</span>
      {trailing && <span style={sectionTrailingStyle}>{trailing}</span>}
    </div>
  );
}

// ─── Styles ─────────────────────────────────────────────────────────

// Match ArtistDetail's outer chrome — same border/radius/maxWidth/
// padding so the two single-entity cards feel like one family.
// Larger inter-section gap (vs ArtistDetail's 18) since this card has
// no section dividers — whitespace is what separates the bands now.
const cardStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 28,
  maxWidth: 720,
  margin: '0 auto',
  padding: '20px 22px 22px',
  borderRadius: 12,
  border: '1px solid var(--color-border-tertiary, rgba(127,127,127,0.12))',
  background: 'var(--color-background-primary, transparent)',
  color: 'var(--color-text-primary, #1a1a1a)',
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
};

const heroStyle: CSSProperties = {
  display: 'flex',
  gap: 16,
  alignItems: 'center',
};

const portraitStyle: CSSProperties = {
  width: HEAD_PX,
  height: HEAD_PX,
  borderRadius: '50%',
  overflow: 'hidden',
  flexShrink: 0,
  background: 'rgba(127,127,127,0.08)',
  position: 'relative',
};

const portraitImgStyle: CSSProperties = {
  position: 'absolute',
  inset: 0,
  width: '100%',
  height: '100%',
  objectFit: 'cover',
};

const heroRightStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  minWidth: 0,
};

const titleStyle: CSSProperties = {
  margin: 0,
  fontSize: 26,
  fontWeight: 700,
  letterSpacing: -0.3,
  lineHeight: 1.1,
};

const badgeRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  flexWrap: 'wrap',
};

const teamBadgeStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
};

const teamAbbrStyle: CSSProperties = {
  fontSize: 14,
  fontWeight: 700,
  letterSpacing: 0.4,
};

const chipStyle: CSSProperties = {
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

const bioStripStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
  gap: 10,
  margin: 0,
  padding: '12px 14px',
  borderRadius: 10,
  background: 'rgba(127,127,127,0.06)',
};

const bioPairStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
};

const bioKeyStyle: CSSProperties = {
  fontSize: 10,
  fontWeight: 600,
  letterSpacing: 0.6,
  textTransform: 'uppercase',
  opacity: 0.55,
};

const bioValueStyle: CSSProperties = {
  margin: 0,
  fontSize: 13,
  fontWeight: 500,
};

// Per-section spacing — header → content gap matches HitterStatBlock
// so all sections breathe the same way regardless of which component
// renders the body.
const sectionStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
};

// Tab nav — bleeds horizontally to the outer card edge (same trick as
// the soft career table) so the bottom hairline reads as a section
// divider instead of a floating underline.
const tabNavStyle: CSSProperties = {
  display: 'flex',
  gap: 4,
  marginLeft: -CARD_PADDING_X,
  marginRight: -CARD_PADDING_X,
  paddingLeft: CARD_PADDING_X,
  paddingRight: CARD_PADDING_X,
  borderBottom: '1px solid rgba(127,127,127,0.12)',
};

const tabButtonStyle: CSSProperties = {
  appearance: 'none',
  background: 'transparent',
  border: 'none',
  borderBottom: '2px solid transparent',
  padding: '8px 12px',
  marginBottom: -1, // align underline with the strip's bottom border
  fontSize: 12,
  fontWeight: 700,
  letterSpacing: 0.6,
  textTransform: 'uppercase',
  cursor: 'pointer',
  fontFamily: 'inherit',
  transition: 'color 120ms ease, opacity 120ms ease',
};

const sectionHeaderStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'baseline',
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: 0.8,
  textTransform: 'uppercase',
  opacity: 0.55,
};

const sectionTrailingStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 500,
  letterSpacing: 0.4,
  opacity: 0.6,
  textTransform: 'none',
};

const bigFourStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(80px, 1fr))',
  gap: 8,
};

const bigFourCellStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-start',
  gap: 2,
};

const bigFourValueStyle: CSSProperties = {
  fontSize: 32,
  fontWeight: 700,
  lineHeight: 1,
  fontVariantNumeric: 'tabular-nums',
  letterSpacing: -0.5,
};

const bigFourLabelStyle: CSSProperties = {
  fontSize: 10,
  fontWeight: 600,
  letterSpacing: 0.6,
  textTransform: 'uppercase',
  opacity: 0.55,
};

const splitsGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
  gap: 10,
};

const splitCellStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  padding: '12px 14px',
  borderRadius: 10,
  background: 'rgba(127,127,127,0.06)',
};

const splitLabelStyle: CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: 0.6,
  textTransform: 'uppercase',
  opacity: 0.55,
};

const splitValueStyle: CSSProperties = {
  fontSize: 22,
  fontWeight: 700,
  lineHeight: 1.1,
  fontVariantNumeric: 'tabular-nums',
};

const splitSubStyle: CSSProperties = {
  fontSize: 11,
  opacity: 0.7,
  fontVariantNumeric: 'tabular-nums',
};

// Career — 'soft' treatment: no outer container; alt-row stripes
// bleed past the column grid out to the outer card padding via a
// negative-margin wrapper. First/last cells absorb the bleed amount
// back as padding so the year column stays flush with the section
// header on the left and the last column flush with the right edge.
const tableBleedStyle: CSSProperties = {
  overflowX: 'auto',
  marginLeft: -CARD_PADDING_X,
  marginRight: -CARD_PADDING_X,
};

const tableStyleSoft: CSSProperties = {
  width: '100%',
  borderCollapse: 'collapse',
  fontSize: 12,
  fontVariantNumeric: 'tabular-nums',
};

const thStyleSoft: CSSProperties = {
  textAlign: 'left',
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: 0.5,
  textTransform: 'uppercase',
  opacity: 0.55,
  padding: '6px 8px',
};

const thRightStyleSoft: CSSProperties = {
  ...thStyleSoft,
  textAlign: 'right',
};

const thFirstStyleSoft: CSSProperties = {
  ...thStyleSoft,
  paddingLeft: CARD_PADDING_X,
};

const thLastRightStyleSoft: CSSProperties = {
  ...thRightStyleSoft,
  paddingRight: CARD_PADDING_X,
};

const tdStyleSoft: CSSProperties = {
  padding: '7px 8px',
  fontSize: 12,
};

const tdRightStyleSoft: CSSProperties = {
  ...tdStyleSoft,
  textAlign: 'right',
};

const tdFirstStyleSoft: CSSProperties = {
  ...tdStyleSoft,
  paddingLeft: CARD_PADDING_X,
};

const tdLastRightStyleSoft: CSSProperties = {
  ...tdRightStyleSoft,
  paddingRight: CARD_PADDING_X,
};

const trStripeStyle: CSSProperties = {
  background: 'rgba(127,127,127,0.07)',
};

const awardsListStyle: CSSProperties = {
  listStyle: 'none',
  margin: 0,
  padding: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
};

const awardRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
};

const awardDotStyle: CSSProperties = {
  width: 7,
  height: 7,
  borderRadius: '50%',
  flexShrink: 0,
};

const awardNameStyle: CSSProperties = {
  fontSize: 13,
  fontWeight: 500,
  flex: 1,
};

const awardSeasonStyle: CSSProperties = {
  fontSize: 12,
  opacity: 0.6,
  fontVariantNumeric: 'tabular-nums',
};

const appearancesStyle: CSSProperties = {
  listStyle: 'none',
  margin: 0,
  padding: 0,
  display: 'flex',
  flexDirection: 'column',
};

const appearanceRowStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  padding: '10px 0',
  borderTop: '1px solid rgba(127,127,127,0.08)',
};

const appearanceRowFirstStyle: CSSProperties = {
  ...appearanceRowStyle,
  borderTop: 'none',
  paddingTop: 0,
};

const appearanceHeaderStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  gap: 10,
  minWidth: 0,
};

const appearanceDateStyle: CSSProperties = {
  fontSize: 12,
  opacity: 0.6,
  fontVariantNumeric: 'tabular-nums',
  marginLeft: 'auto',
  flexShrink: 0,
};

const appearanceTitleStyle: CSSProperties = {
  fontSize: 13,
  fontWeight: 500,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  minWidth: 0,
};

const appearanceStatRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
};

const appearanceStatStyle: CSSProperties = {
  fontSize: 11,
  opacity: 0.7,
  fontVariantNumeric: 'tabular-nums',
};

const notableDotStyle: CSSProperties = {
  width: 7,
  height: 7,
  borderRadius: '50%',
  flexShrink: 0,
};

const emptyStyle: CSSProperties = {
  fontSize: 12,
  opacity: 0.6,
  fontStyle: 'italic',
};
