import { useState, type CSSProperties } from 'react';
import { thumbhashToDataUrl } from '../lib/thumbhash.js';
import { TeamLogo } from './TeamLogo.js';
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

  return (
    <article style={cardStyle}>
      <Hero player={player} />
      <BioStrip player={player} />

      <SectionHeader>{season_stats?.season ?? '—'} season</SectionHeader>
      {season_stats?.hitter ? (
        <BigFourHitter
          avg={season_stats.hitter.avg}
          obp={season_stats.hitter.obp}
          slg={season_stats.hitter.slg}
          ops={season_stats.hitter.ops}
          tint={tint}
        />
      ) : season_stats?.pitcher ? (
        <BigFourPitcher
          era={season_stats.pitcher.era}
          whip={season_stats.pitcher.whip}
          k={season_stats.pitcher.k}
          ip={season_stats.pitcher.ip}
          tint={tint}
        />
      ) : (
        <div style={emptyStyle}>Season stats unavailable</div>
      )}
      {season_stats?.hitter && (
        <CountingRow
          stats={[
            ['G', fmt(season_stats.hitter.games_played)],
            ['PA', fmt(season_stats.hitter.pa)],
            ['AB', fmt(season_stats.hitter.ab)],
            ['HR', fmt(season_stats.hitter.hr)],
            ['RBI', fmt(season_stats.hitter.rbi)],
            ['R', fmt(season_stats.hitter.r)],
            ['2B', fmt(season_stats.hitter.doubles)],
            ['BB', fmt(season_stats.hitter.bb)],
            ['K', fmt(season_stats.hitter.k)],
            ['SB', fmt(season_stats.hitter.sb)],
          ]}
        />
      )}

      {splits && hasAnySplit(splits) && (
        <>
          <SectionHeader>Splits</SectionHeader>
          <SplitsGrid splits={splits} tint={tint} />
        </>
      )}

      {attended_summary?.hitter && (
        <>
          <SectionHeader trailing={`${attended_summary.games_attended} games`}>
            In games you attended
          </SectionHeader>
          <BigFourHitter
            avg={attended_summary.hitter.avg ?? null}
            obp={null}
            slg={attended_summary.hitter.slg ?? null}
            ops={null}
            tint={tint}
          />
          <CountingRow
            stats={[
              [
                'H/AB',
                `${fmt(attended_summary.hitter.h)}/${fmt(attended_summary.hitter.ab)}`,
              ],
              ['HR', fmt(attended_summary.hitter.hr)],
              ['RBI', fmt(attended_summary.hitter.rbi)],
              ['BB', fmt(attended_summary.hitter.bb)],
              ['K', fmt(attended_summary.hitter.k)],
            ]}
          />
          {attended_summary.games_attended >
            attended_summary.games_with_box_score && (
            <div style={subtleNoteStyle}>
              {attended_summary.games_with_box_score} of{' '}
              {attended_summary.games_attended} games have box-score data
            </div>
          )}
        </>
      )}

      {career && career.seasons.length > 0 && (
        <>
          <SectionHeader>Career</SectionHeader>
          <CareerTable career={career} tint={tint} />
        </>
      )}

      {player.awards && player.awards.length > 0 && (
        <>
          <SectionHeader>Career highlights</SectionHeader>
          <AwardsList awards={player.awards} tint={tint} />
        </>
      )}

      {attended_appearances.length > 0 && (
        <>
          <SectionHeader
            trailing={
              attended_appearance_count > attended_appearances.length
                ? `${attended_appearance_count} total`
                : undefined
            }
          >
            Recent appearances
          </SectionHeader>
          <RecentAppearancesList
            appearances={attended_appearances}
            tint={tint}
          />
        </>
      )}
    </article>
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
              <TeamLogo team={player.primary_team} size={28} variant="auto" />
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

function BigFourHitter({
  avg,
  obp,
  slg,
  ops,
  tint,
}: {
  avg: string | null | undefined;
  obp: string | null | undefined;
  slg: string | null | undefined;
  ops: string | null | undefined;
  tint: string;
}) {
  const cells: Array<[string, string]> = [];
  if (avg) cells.push(['AVG', avg]);
  if (obp) cells.push(['OBP', obp]);
  if (slg) cells.push(['SLG', slg]);
  if (ops) cells.push(['OPS', ops]);
  if (cells.length === 0) return null;
  return (
    <div style={bigFourStyle}>
      {cells.map(([k, v]) => (
        <div key={k} style={bigFourCellStyle}>
          <div style={{ ...bigFourValueStyle, color: tint }}>{v}</div>
          <div style={bigFourLabelStyle}>{k}</div>
        </div>
      ))}
    </div>
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

function CountingRow({ stats }: { stats: Array<[string, string]> }) {
  return (
    <div style={countingRowStyle}>
      {stats.map(([k, v]) => (
        <div key={k} style={countingCellStyle}>
          <div style={countingValueStyle}>{v}</div>
          <div style={countingLabelStyle}>{k}</div>
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
}: {
  career: NonNullable<CareerHistory>;
  tint: string;
}) {
  const isHitter = career.group === 'hitting';
  const seasons = (
    isHitter
      ? (career.seasons as CareerHittingSeason[])
      : (career.seasons as CareerPitchingSeason[])
  )
    .slice()
    .reverse(); // newest first
  if (isHitter) {
    return (
      <div style={tableWrapStyle}>
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thStyle}>Year</th>
              <th style={thStyle}>Team</th>
              <th style={thRightStyle}>G</th>
              <th style={thRightStyle}>AB</th>
              <th style={thRightStyle}>HR</th>
              <th style={thRightStyle}>RBI</th>
              <th style={thRightStyle}>AVG</th>
              <th style={thRightStyle}>OPS</th>
            </tr>
          </thead>
          <tbody>
            {(seasons as CareerHittingSeason[]).map((s, i) => (
              <tr key={`${s.season}-${s.team_id ?? i}`}>
                <td style={tdStyle}>{s.season}</td>
                <td style={tdStyle}>{abbreviateTeam(s.team_name)}</td>
                <td style={tdRightStyle}>{fmt(s.games_played)}</td>
                <td style={tdRightStyle}>{fmt(s.ab)}</td>
                <td style={{ ...tdRightStyle, fontWeight: 600 }}>
                  {fmt(s.hr)}
                </td>
                <td style={tdRightStyle}>{fmt(s.rbi)}</td>
                <td style={{ ...tdRightStyle, color: tint, fontWeight: 600 }}>
                  {s.avg ?? '—'}
                </td>
                <td style={tdRightStyle}>{s.ops ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  return (
    <div style={tableWrapStyle}>
      <table style={tableStyle}>
        <thead>
          <tr>
            <th style={thStyle}>Year</th>
            <th style={thStyle}>Team</th>
            <th style={thRightStyle}>G</th>
            <th style={thRightStyle}>IP</th>
            <th style={thRightStyle}>K</th>
            <th style={thRightStyle}>W-L</th>
            <th style={thRightStyle}>ERA</th>
            <th style={thRightStyle}>WHIP</th>
          </tr>
        </thead>
        <tbody>
          {(seasons as CareerPitchingSeason[]).map((s, i) => (
            <tr key={`${s.season}-${s.team_id ?? i}`}>
              <td style={tdStyle}>{s.season}</td>
              <td style={tdStyle}>{abbreviateTeam(s.team_name)}</td>
              <td style={tdRightStyle}>{fmt(s.games_played)}</td>
              <td style={tdRightStyle}>{s.ip ?? '—'}</td>
              <td style={tdRightStyle}>{fmt(s.k)}</td>
              <td style={tdRightStyle}>
                {fmt(s.wins)}-{fmt(s.losses)}
              </td>
              <td style={{ ...tdRightStyle, color: tint, fontWeight: 600 }}>
                {s.era ?? '—'}
              </td>
              <td style={tdRightStyle}>{s.whip ?? '—'}</td>
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
      {appearances.map((a) => (
        <li key={a.event_id} style={appearanceRowStyle}>
          <div style={appearanceDateStyle}>{formatDateShort(a.event_date)}</div>
          <div style={appearanceMainStyle}>
            <div style={appearanceTitleStyle}>{a.title}</div>
            <div style={appearanceStatStyle}>{summarizeStatLine(a)}</div>
          </div>
          {a.notable && (
            <span style={{ ...notableDotStyle, background: tint }} />
          )}
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

const cardStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 18,
  padding: 20,
  background: 'transparent',
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

const sectionHeaderStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'baseline',
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: 0.8,
  textTransform: 'uppercase',
  opacity: 0.55,
  paddingTop: 4,
  borderTop: '1px solid rgba(127,127,127,0.18)',
  marginTop: 4,
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

const countingRowStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 16,
  paddingTop: 4,
};

const countingCellStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 1,
  minWidth: 36,
};

const countingValueStyle: CSSProperties = {
  fontSize: 14,
  fontWeight: 600,
  fontVariantNumeric: 'tabular-nums',
};

const countingLabelStyle: CSSProperties = {
  fontSize: 10,
  fontWeight: 600,
  letterSpacing: 0.5,
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

const tableWrapStyle: CSSProperties = {
  overflowX: 'auto',
  maxWidth: '100%',
};

const tableStyle: CSSProperties = {
  width: '100%',
  borderCollapse: 'collapse',
  fontSize: 12,
  fontVariantNumeric: 'tabular-nums',
};

const thStyle: CSSProperties = {
  textAlign: 'left',
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: 0.5,
  textTransform: 'uppercase',
  opacity: 0.55,
  padding: '6px 8px',
  borderBottom: '1px solid rgba(127,127,127,0.18)',
};

const thRightStyle: CSSProperties = {
  ...thStyle,
  textAlign: 'right',
};

const tdStyle: CSSProperties = {
  padding: '7px 8px',
  borderBottom: '1px solid rgba(127,127,127,0.08)',
  fontSize: 12,
};

const tdRightStyle: CSSProperties = {
  ...tdStyle,
  textAlign: 'right',
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
  display: 'grid',
  gridTemplateColumns: '110px 1fr auto',
  alignItems: 'center',
  gap: 10,
  padding: '10px 0',
  borderTop: '1px solid rgba(127,127,127,0.08)',
};

const appearanceDateStyle: CSSProperties = {
  fontSize: 12,
  opacity: 0.7,
  fontVariantNumeric: 'tabular-nums',
};

const appearanceMainStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  minWidth: 0,
};

const appearanceTitleStyle: CSSProperties = {
  fontSize: 13,
  fontWeight: 500,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
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

const subtleNoteStyle: CSSProperties = {
  fontSize: 11,
  opacity: 0.55,
  fontStyle: 'italic',
  paddingTop: 2,
};
