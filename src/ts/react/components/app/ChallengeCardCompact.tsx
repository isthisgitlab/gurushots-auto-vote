import type { ComponentChildren } from 'preact';
import type { Challenge } from '../../../types/gurushots';
import type { RankedChallenge } from '../../../types/rendererUtils';
import type { EntryPins } from '../../../types/settings';
import type { ChallengeCardView } from './ChallengeCard';
import type { ChallengeBadgeRowProps } from './ChallengeBadgeRow';
import type { DeadlineAction } from './DeadlineTimeline';
import { useTranslation } from '@/contexts/TranslationContext';
import { getEntryStatus, statusText } from '@/utils/formatters';
import { ChallengeBadgeRow } from './ChallengeBadgeRow';
import { CardDensityToggle } from './CardDensityToggle';
import { Countdown } from './Countdown';
import type { TimeRemaining } from './Countdown';
import { DeadlineTimeline } from './DeadlineTimeline';
import { ScenarioStatusLine } from './ScenarioStatusLine';
import { livePinKindOf, unusablePins } from '../../../voting/entryPins';
import { interp } from '@/utils/interp';
import type * as useScenarioStatusModule from '@/api/useScenarioStatus';

/**
 * One labelled stat in the compact tile's grid. The emoji is the visual label;
 * the translated name rides on `title` so the cell stays one short line.
 */
function Stat({
    icon,
    label,
    className = '',
    children,
}: {
    icon: string;
    label: string;
    className?: string;
    children: ComponentChildren;
}) {
    return (
        <div className={`truncate ${className}`} title={label}>
            <span aria-hidden="true">{icon}</span> <span className="sr-only">{label}: </span>
            {children}
        </div>
    );
}

/**
 * Compact challenge tile — a summary of state (time, exposure, rank,
 * boost/turbo, entries and each entry's boost/turbo mark). By default it offers
 * no actions and the density toggle is its only control. With the
 * compactCardActions setting on, the parent passes `actions`: a footer row of
 * the challenge-level actions (vote, run, earn turbo, submit, currency spends,
 * settings). Per-entry actions (boost/turbo placement, swap, photo preview)
 * stay in the detailed card either way.
 *
 * Several tiles share a grid row (see ChallengesSection), so everything is
 * sized for a ~16rem column: one truncating title line, a 2-column stat grid.
 *
 * All values are derived by the parent ChallengeCard and passed in, so the
 * tile and the detailed card can never disagree about what a state means.
 *
 * @param props.pins - the photos pinned for Boost and Turbo, marked in the entry glyph row
 * @param props.actions - the optional footer action row
 */
export function ChallengeCardCompact({
    challenge,
    badgeRowProps,
    timeRemaining,
    exposureFactor,
    exposureClass,
    boostStatus,
    turboStatus,
    entries,
    pins,
    hasCompactOverride,
    onToggleCompact,
    boostWarning,
    turboWarning,
    deadlineActions,
    scenarioStatus,
    actions,
}: {
    challenge: Challenge;
    badgeRowProps: ChallengeBadgeRowProps;
    timeRemaining: TimeRemaining;
    exposureFactor: ChallengeCardView['exposureFactor'];
    exposureClass: ChallengeCardView['exposureClass'];
    boostStatus: ChallengeCardView['boostStatus'];
    turboStatus: ChallengeCardView['turboStatus'];
    entries: ChallengeCardView['entries'];
    pins: EntryPins;
    hasCompactOverride: boolean;
    onToggleCompact: () => void | Promise<void>;
    boostWarning: string | null;
    turboWarning: string | null;
    deadlineActions: DeadlineAction[];
    scenarioStatus: ReturnType<typeof useScenarioStatusModule.useScenarioStatus>;
    actions: ComponentChildren;
}) {
    const { t } = useTranslation();
    const progress = (challenge as RankedChallenge).member.ranking.total;
    const rank = progress?.rank;
    const hasRank = rank !== undefined && rank > 0;
    // One muted mark for the pins that are stored but not taking effect: it names the feature(s) once, the card says why.
    const notApplying = unusablePins(challenge, pins).map(({ kind }) => kind);
    const names = { boost: t('app.boost'), turbo: t('app.turbo') };
    let notApplyingNote: { short: string; long: string } | null = null;
    if (notApplying.length > 0) {
        const nameVars = { ...names, kind: names[notApplying[0]] };
        const both = notApplying.length > 1;
        notApplyingNote = {
            short: interp(t(both ? 'app.pinNotApplyingShortBoth' : 'app.pinNotApplyingShort'), nameVars),
            long: interp(t(both ? 'app.pinNotApplyingBoth' : 'app.pinNotApplying'), nameVars),
        };
    }

    return (
        <div className="space-y-2">
            <div>
                <div className="flex items-start gap-1">
                    <h3 className="font-bold text-sm truncate flex-1 min-w-0" title={challenge.title}>
                        {challenge.title}
                    </h3>
                    <CardDensityToggle isCompact hasOverride={hasCompactOverride} onToggle={onToggleCompact} />
                </div>
                <ChallengeBadgeRow {...badgeRowProps} showPhotoCount={false} />
            </div>

            <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-base-content/80">
                <Stat icon="⏱" label={t('app.time')}>
                    <Countdown source={timeRemaining} className="font-medium" />
                </Stat>
                <Stat icon="📊" label={t('app.exposure')} className={exposureClass}>
                    {exposureFactor}%
                </Stat>
                <Stat icon="🏆" label={t('app.rank')}>
                    {hasRank ? `${rank.toLocaleString()} / ${challenge.players.toLocaleString()}` : '—'}
                </Stat>
                <Stat icon="🖼" label={t('app.yourEntries')}>
                    {entries.length}/{challenge.max_photo_submits}
                </Stat>
                <Stat icon="🚀" label={t('app.boost')} className={boostStatus.colorClass}>
                    {statusText(boostStatus, t)}
                </Stat>
                <Stat icon="⚡" label={t('app.turbo')} className={turboStatus.colorClass}>
                    {statusText(turboStatus, t)}
                </Stat>
            </div>

            {/* Per-entry state as glyphs: which photo is boosted / turboed /
                guru-picked, and its rank. No thumbnail, no buttons. */}
            {entries.length > 0 && (
                <div
                    className="flex flex-wrap gap-x-2 gap-y-0.5 text-xs"
                    role="group"
                    aria-label={t('app.entryDetails')}
                >
                    {entries.map((entry) => {
                        const { icon, textClass } = getEntryStatus(entry);
                        const pinned = livePinKindOf(challenge, entry, pins);
                        return (
                            <span
                                key={entry.id}
                                className={textClass}
                                title={`${t('app.rank')} ${entry.rank} (${entry.votes} ${t('app.votes')})`}
                            >
                                {icon} #{entry.rank}
                                {pinned && (
                                    <>
                                        <span aria-hidden="true">{pinned === 'boost' ? '🚀📌' : '⚡📌'}</span>
                                        <span className="sr-only">
                                            {t(pinned === 'boost' ? 'app.pinnedForBoost' : 'app.pinnedForTurbo')}
                                        </span>
                                    </>
                                )}
                            </span>
                        );
                    })}
                </div>
            )}

            {notApplyingNote && (
                // Visible short text, not just a glyph: a title is invisible on touch, and a dimmed pin alone reads
                // like the live-pin mark. The full sentence is for screen readers and the title.
                <div className="text-xs text-base-content/60" title={notApplyingNote.long}>
                    <span aria-hidden="true">📌 {notApplyingNote.short}</span>
                    <span className="sr-only">{notApplyingNote.long}</span>
                </div>
            )}

            {/* Boost/turbo conflict is state worth seeing even in the tile —
                a one-line note instead of the detailed card's alert box. */}
            {[boostWarning, turboWarning].map(
                (warning) =>
                    warning && (
                        // line-clamp-2 cuts a long sentence off; the title carries it whole.
                        <div key={warning} className="text-xs text-warning line-clamp-2" role="alert" title={warning}>
                            ⚠ {warning}
                        </div>
                    ),
            )}

            <DeadlineTimeline actions={deadlineActions} compact />
            <ScenarioStatusLine status={scenarioStatus} compact />

            {actions}
        </div>
    );
}
