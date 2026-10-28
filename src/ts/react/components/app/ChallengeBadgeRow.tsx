import { useTranslation } from '@/contexts/TranslationContext';
import { exposureText } from '@/utils/challengeCardView';
import { StatusBadge } from '../ui/StatusBadge';
import { PulseDot } from '../ui/PulseDot';
import { ChallengeKindBadges } from './ChallengeKindBadges';
import { challengeKind, challengePhotoCount } from '../../../format/challengeListing';

import type { Challenge, TeamMatch, TeamStanding } from '../../../types/gurushots';
import type { ChallengeCardView } from './ChallengeCard';

/**
 * Our standing among the match's scoring slots, worded as the lineup the GuruShots team screen names:
 * where we sit among the active players, how far we are over the best standby player (0 stays visible —
 * a one-vote lead still is one), or how many votes we miss to leave the standbys.
 */
function TeamStandingBadge({ standing }: { standing: TeamStanding }) {
    const { t } = useTranslation();
    const label =
        standing.kind === 'active'
            ? t('app.teamStandingActive', { position: standing.position.toLocaleString() }) +
              (standing.cushion === null ? '' : ` · ${t('app.teamStandingOverStandby', { count: standing.cushion })}`)
            : t('app.teamStandingStandby', { count: standing.votesToActive });
    return <StatusBadge variant="ghost">{label}</StatusBadge>;
}

/**
 * The team-match marker, both teams' vote totals and our lead (green +N) or deficit (red −N), all as visible
 * text so touch and keyboard users see them. The opponent is another user's text: only ever a React text child.
 * The marker wraps instead of truncating (`badge` is fixed-height, hence `h-auto`; `wrap-anywhere` also breaks
 * one long unbroken word). A match that is no longer running says so in place of the standing badge.
 */
function TeamMatchBadges({ teamMatch }: { teamMatch: TeamMatch }) {
    const { t } = useTranslation();
    const diff = teamMatch.us.votes - teamMatch.them.votes;
    const { variant, sign, word } =
        diff > 0
            ? { variant: 'success' as const, sign: `+${diff.toLocaleString()}`, word: t('app.teamMatchAhead') }
            : diff < 0
              ? {
                    variant: 'error' as const,
                    sign: `\u2212${(-diff).toLocaleString()}`,
                    word: t('app.teamMatchBehind'),
                }
              : { variant: 'neutral' as const, sign: '\u00b10', word: t('app.teamMatchTied') };
    return (
        <>
            <StatusBadge variant="ghost" className="h-auto py-0.5 wrap-anywhere">
                <span aria-hidden="true">👥 </span>
                {t('app.teamMatchVs', { opponent: teamMatch.them.name })}
            </StatusBadge>
            <StatusBadge variant="ghost">
                {t('app.teamMatchVotes', {
                    us: teamMatch.us.votes.toLocaleString(),
                    them: teamMatch.them.votes.toLocaleString(),
                })}
            </StatusBadge>
            <StatusBadge variant={variant} className="font-semibold">
                {sign}
                <span className="sr-only"> {word}</span>
            </StatusBadge>
            {teamMatch.running === false ? (
                <StatusBadge variant="ghost">{t('app.teamMatchNotRunning')}</StatusBadge>
            ) : (
                teamMatch.me && <TeamStandingBadge standing={teamMatch.me} />
            )}
        </>
    );
}

export type ChallengeBadgeRowProps = Pick<
    ChallengeCardView,
    'boostOpen' | 'boostTimeLeft' | 'lowExposure' | 'exposureFactor' | 'showAutoSubmitBadge' | 'showManualPhotosBadge'
> & {
    challenge: Challenge;
    hasCustomSettings: boolean;
    showPhotoCount?: boolean;
};

/**
 * Challenge badge row, shared by the detailed card and the compact tile.
 *
 * Two categories: "logical/state" badges that reflect live challenge/automation
 * state, and an "override/config" badge that marks user-configured overrides.
 * They are styled differently (solid vs muted ghost) and separated so a config
 * marker is never mistaken for a live state. The two at-a-glance alerts (open
 * boost window, low exposure — see utils/challengeAlerts) lead the state group
 * and stay in the compact tile, where standing out without reading is the point.
 *
 * `boostTimeLeft` (preformatted, e.g. "23m") is shown in the boost badge for a
 * timed window — the tile's boost cell truncates, so the badge carries it.
 *
 * `showPhotoCount` is off in the compact tile, where the entries cell already
 * reads N/max and the "N photos" badge would only repeat the max.
 */
export function ChallengeBadgeRow({
    challenge,
    boostOpen,
    boostTimeLeft,
    lowExposure,
    exposureFactor,
    showAutoSubmitBadge,
    showManualPhotosBadge,
    hasCustomSettings,
    showPhotoCount = true,
}: ChallengeBadgeRowProps) {
    const { t } = useTranslation();
    const showPhotos = showPhotoCount && challengePhotoCount(challenge) !== null;
    const hasLogicalBadge = Boolean(
        boostOpen ||
        lowExposure ||
        challengeKind(challenge) ||
        showPhotos ||
        showAutoSubmitBadge ||
        showManualPhotosBadge ||
        challenge.teamMatch,
    );

    if (!hasLogicalBadge && !hasCustomSettings) return null;

    return (
        <div className="flex flex-wrap items-center gap-1 mt-1">
            {boostOpen && (
                <StatusBadge variant="info" className="gap-1 font-semibold">
                    <PulseDot variant="info" size="status-sm" onBadge />
                    🚀 {t('app.boostOpenBadge')}
                    {boostTimeLeft && <span>· ⏳ {boostTimeLeft}</span>}
                </StatusBadge>
            )}
            {lowExposure && (
                <StatusBadge variant="error" className="gap-1 font-semibold">
                    <PulseDot variant="error" pulse={exposureFactor === 0} size="status-sm" onBadge />
                    👁 {t('app.exposure')} {exposureText(exposureFactor)}
                </StatusBadge>
            )}
            <ChallengeKindBadges challenge={challenge} showPhotoCount={showPhotoCount} />
            {challenge.teamMatch && <TeamMatchBadges teamMatch={challenge.teamMatch} />}
            {showAutoSubmitBadge && <StatusBadge variant="success">📥 {t('app.autoSubmitBadge')}</StatusBadge>}
            {showManualPhotosBadge && <StatusBadge variant="ghost">✋ {t('app.manualPhotosBadge')}</StatusBadge>}
            {hasLogicalBadge && hasCustomSettings && (
                <span data-testid="badge-divider" className="w-px h-3 bg-base-300 mx-0.5 self-center" />
            )}
            {hasCustomSettings && <StatusBadge variant="ghost">⚙️ {t('app.customBadge')}</StatusBadge>}
        </div>
    );
}
