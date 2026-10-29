import { Fragment, useId, useMemo } from 'react';
import { useTranslation } from '@/contexts/TranslationContext';
import { formatEndTime, getLevelStatus, statusText } from '@/utils/formatters';
import { countText, exposureText, getNextLevelInfo } from '@/utils/challengeCardView';
import { sanitizeWelcomeMessage } from '@/utils/sanitizeWelcomeMessage';
import { statusBadgeClass, toneBadgeClass } from '@/utils/statTone';
import { prizeItemsText } from '@/utils/prizeText';
import { Countdown } from './Countdown';
import type { TimeRemaining } from './Countdown';
import { DeadlineTimeline } from './DeadlineTimeline';
import { ScenarioStatusPanel } from './ScenarioStatusPanel';
import { EntryDetails } from './EntryDetails';
import { ChallengeBadgeRow } from './ChallengeBadgeRow';
import { ChallengeTagBadges } from './ChallengeKindBadges';
import { stringTags } from '../../../format/challengeListing';
import { benchmarkGap, parseBenchmarkScores } from '../../../format/benchmark';
import { CardDensityToggle } from './CardDensityToggle';
import { FillButtons } from './ChallengeCardActions';
import { InlineError } from '@/components/ui/InlineError';
import * as ipc from '@/api/ipc';
import { challengePageUrl } from '@/utils/challengePageUrl';

import type { ComponentChildren } from 'preact';
import type { Bankroll, Challenge, PrizeTier, RankingTotal } from '../../../types/gurushots';
import type { ChallengeCardView } from './ChallengeCard';
import type { ChallengeCardActionSet } from './ChallengeCardActions';
import type { ChallengeBadgeRowProps } from './ChallengeBadgeRow';
import type { DeadlineAction } from './DeadlineTimeline';
import type * as useSwapBacksModule from '@/api/useSwapBacks';
import type * as useEntryPinsModule from '@/api/useEntryPins';
import type * as useScenarioStatusModule from '@/api/useScenarioStatus';

export type SwapBackOffers = ReturnType<typeof useSwapBacksModule.useSwapBacks>;
export type EntryPinsState = ReturnType<typeof useEntryPinsModule.useEntryPins>;

// The value line of a stat cell; Ends alone drops to text-xs, since a long date string needs the room.
const STAT_VALUE = 'text-sm font-semibold tabular-nums';

/**
 * One labelled cell of the detailed card's stat grids.
 */
function StatCell({ label, children }: { label: string; children: ComponentChildren }) {
    return (
        <div className="bg-base-200 rounded-box p-2 text-center flex flex-col gap-1">
            <div className="text-xs font-medium text-base-content/70">{label}</div>
            {children}
        </div>
    );
}

/**
 * Title, welcome message, badges, challenge link and the header actions. The
 * header stacks vertically: the title gets the full card width (so it
 * truncates far less), and the action buttons sit on their own row beneath it,
 * wrapping as needed rather than squeezing the title.
 */
function DetailHeader({
    challenge,
    badgeRowProps,
    actions,
    hasCompactOverride,
    onToggleCompact,
}: {
    challenge: Challenge;
    badgeRowProps: ChallengeBadgeRowProps;
    actions: ChallengeCardActionSet;
    hasCompactOverride: boolean;
    onToggleCompact: () => void | Promise<void>;
}) {
    const sanitizedWelcome = useMemo(
        () => sanitizeWelcomeMessage(challenge.welcome_message),
        [challenge.welcome_message],
    );

    // Only reachable from the URL row, which renders only when challenge.url is set. The slug comes off the network
    // and goes into a URL path: anything but word characters and hyphens opens the generic challenges page instead.
    const handleOpenUrl = () => {
        void ipc.callOrNull(() => ipc.openExternalUrl(challengePageUrl(challenge.url)));
    };

    return (
        <div className="flex flex-col gap-2">
            <div className="min-w-0">
                <h3 className="font-bold text-base wrap-anywhere">{challenge.title}</h3>
                {/* Welcome message. wrap-anywhere wraps the full text, including long unbroken words and URLs, so it never forces the card wider. sanitizeWelcomeMessage strips medium-editor toolbar leakage and allowlists safe tags. */}
                {sanitizedWelcome && (
                    <div
                        className="text-xs text-base-content/70 wrap-anywhere"
                        // aislop-ignore-next-line security/dangerously-set-innerhtml -- sanitized by sanitizeWelcomeMessage
                        dangerouslySetInnerHTML={{ __html: sanitizedWelcome }}
                    />
                )}
                <ChallengeBadgeRow {...badgeRowProps} />
                {challenge.url && (
                    <div className="text-xs text-base-content/70 mt-1">
                        <button
                            onClick={handleOpenUrl}
                            className="font-mono hover:text-info hover:underline text-left min-h-6 py-1"
                        >
                            {challengePageUrl(challenge.url).replace('https://', '')}
                        </button>
                    </div>
                )}
            </div>
            <div className="flex flex-wrap gap-1 shrink-0">
                {actions.voteButton}
                {actions.runButton}
                <div className="flex flex-wrap gap-1 ml-auto">
                    <CardDensityToggle isCompact={false} hasOverride={hasCompactOverride} onToggle={onToggleCompact} />
                    {actions.settingsButton}
                </div>
            </div>
            {actions.pressError && <InlineError onDismiss={actions.clearPressError}>{actions.pressError}</InlineError>}
        </div>
    );
}

/**
 * User progress — full bar + level + next-level info. Rendered whenever the member's vote count
 * reads as a whole number (0 votes is a real count); a missing or garbled one shows nothing.
 * A benchmark challenge also reads the scores
 * to chase (each "Top n" group labelled on its own) and, when the rank and votes
 * can name one, the gap to the next group. `levels_rank_enable: false` hides the
 * level lines alone: the rank, the votes and the bar are not level ranking.
 */
function UserProgressPanel({ challenge, userProgress }: { challenge: Challenge; userProgress: RankingTotal }) {
    const { t } = useTranslation();
    const progressLabelId = useId();
    const nextLevelInfo = getNextLevelInfo(challenge);
    const { colorClass, progressClass } = getLevelStatus(
        userProgress.level as number,
        userProgress.level_name as string,
    );
    // The level badge names its fields: a missing or garbled level or name shows none (the
    // incident shape the boundary warns about), while the bar and the rank can still render.
    const levelShown = typeof userProgress.level === 'number' && typeof userProgress.level_name === 'string';
    const showLevels = challenge.levels_rank_enable !== false;
    const scores = parseBenchmarkScores(userProgress.benchmark);
    const listed = ([1, 10, 100] as const).flatMap((group) => {
        const score = scores[group];
        // Each present group is labelled on its own, so one missing score cannot shift the rest under wrong labels.
        return score === undefined ? [] : [t('app.benchmarkScore', { target: group, count: score })];
    });
    // The gap names a positive integer rank and a readable vote count (0 is a real count):
    // anything else the server sends drops it.
    const rank = userProgress.rank;
    const votes = userProgress.votes;
    const gap =
        typeof rank === 'number' &&
        Number.isInteger(rank) &&
        rank > 0 &&
        typeof votes === 'number' &&
        Number.isInteger(votes) &&
        votes >= 0
            ? benchmarkGap(rank, votes, scores)
            : null;

    return (
        <div className="bg-base-200 rounded p-2">
            <div className="flex justify-between items-center mb-1">
                <span id={progressLabelId} className="text-xs font-medium">
                    {t('app.yourProgress')}
                </span>
                {showLevels && levelShown && (
                    <span className={`badge badge-sm ${colorClass}`}>
                        {userProgress.level_name} {userProgress.level}
                    </span>
                )}
            </div>
            <div className="flex justify-between text-xs mb-1">
                <span>
                    {t('app.rank')} {userProgress.rank} {t('app.of')} {challenge.players}
                </span>
                <span>
                    {userProgress.votes} {t('app.votes')}
                </span>
            </div>
            {(listed.length > 0 || gap !== null) && (
                <div className="text-xs text-base-content/70 mb-1">
                    {listed.length > 0 && listed.join(' · ')}
                    {listed.length > 0 && gap !== null && ' · '}
                    {gap !== null && t('app.benchmarkGap', { count: gap.n, target: gap.target })}
                </div>
            )}
            <div className="flex items-center gap-2">
                {/* The bar and its % label only for a readable percentage; the incident shape the
                    boundary warns about (a missing or garbled one) shows neither. */}
                {typeof userProgress.percent === 'number' && (
                    <>
                        <progress
                            className={`progress ${progressClass} w-full`}
                            value={userProgress.percent}
                            max="100"
                            aria-labelledby={progressLabelId}
                        />
                        {/* The bar alone says it by colour and length; the progress element already announces the value. */}
                        <span className="text-xs tabular-nums shrink-0" aria-hidden="true">
                            {Math.round(userProgress.percent)}%
                        </span>
                    </>
                )}
            </div>
            {showLevels && challenge.type !== 'flash' && (
                <div className="text-xs text-base-content/70 mt-1">{userProgress.next_message}</div>
            )}
            {nextLevelInfo && (
                <div className="text-xs text-base-content/70 mt-1">
                    {t('app.next')}: {nextLevelInfo.levelName} (
                    {t('app.votesNeeded', { count: nextLevelInfo.votesNeeded })})
                </div>
            )}
        </div>
    );
}

/**
 * 6-cell live-state grid (time, end, exposure, boost, turbo, entries) with the
 * cell-placed actions — stacks 2-up on phones, 3-up on small tablets, 6-up on
 * desktop.
 */
function StatusCells({
    challenge,
    view,
    timeRemaining,
    timezone,
    actions,
}: {
    challenge: Challenge;
    view: ChallengeCardView;
    timeRemaining: TimeRemaining;
    timezone: string;
    actions: ChallengeCardActionSet;
}) {
    const { t } = useTranslation();
    const { turboError, fillError, clearTurboError, clearFillError } = actions;

    return (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-2 text-xs">
            <StatCell label={t('app.time')}>
                <div className={STAT_VALUE}>
                    <Countdown source={timeRemaining} closeTime={challenge.close_time} />
                </div>
            </StatCell>
            <StatCell label={t('app.ends')}>
                <div className="text-xs font-semibold tabular-nums">
                    {formatEndTime(challenge.close_time, timezone)}
                </div>
            </StatCell>
            <StatCell label={t('app.exposure')}>
                <div className={STAT_VALUE}>
                    <span className={toneBadgeClass(view.exposureTone, 'md')}>{exposureText(view.exposureFactor)}</span>
                </div>
                {actions.fillExposureButton}
            </StatCell>
            <StatCell label={t('app.boost')}>
                <div className={STAT_VALUE}>
                    <span className={statusBadgeClass(view.boostStatus.colorClass, 'md')}>
                        {statusText(view.boostStatus, t)}
                    </span>
                </div>
                {actions.keyUnlockButton}
            </StatCell>
            <StatCell label={t('app.turbo')}>
                <div className={STAT_VALUE}>
                    <span className={statusBadgeClass(view.turboStatus.colorClass, 'md')}>
                        {statusText(view.turboStatus, t)}
                    </span>
                </div>
                {actions.earnTurboButton}
                {turboError && <InlineError onDismiss={clearTurboError}>{turboError}</InlineError>}
            </StatCell>
            <StatCell label={t('app.yourEntries')}>
                <div className={STAT_VALUE}>
                    {/* A max the read left non-finite shows no fraction — never "1/undefined". */}
                    {Number.isFinite(challenge.max_photo_submits)
                        ? `${view.entries.length}/${challenge.max_photo_submits}`
                        : '—'}
                </div>
                {view.canFill && (
                    <div className="flex flex-wrap gap-2 justify-center">
                        <FillButtons {...actions.fillButtonProps} />
                    </div>
                )}
                {fillError && <InlineError onDismiss={clearFillError}>{fillError}</InlineError>}
            </StatCell>
        </div>
    );
}

/**
 * The challenge's achievement tiers: each with its title, the rank window it covers (top photographers or
 * top photos — a tier with no readable rank window shows its title alone), and its prizes as type × amount.
 * The parts are separated visually by the flex gap and for assistive technology by an sr-only comma.
 * Tier titles are the server's text: React text children only.
 * A native <details> disclosure: collapsed by default, opened on demand.
 */
function PrizesPanel({ tiers }: { tiers: PrizeTier[] }) {
    const { t } = useTranslation();
    const rankWindowOf = (tier: PrizeTier): string | null => {
        const { min_rank: min, max_rank: max, type } = tier.rank ?? {};
        if (typeof min !== 'number' || typeof max !== 'number') return null;
        // A one-rank window names the rank alone, never a "#n–n" range.
        if (type === 'MEMBER') {
            return min === max
                ? t('app.prizeTierTopPhotographerSingle', { min })
                : t('app.prizeTierTopPhotographer', { min, max });
        }
        if (type === 'IMAGE') {
            return min === max ? t('app.prizeTierTopPhotoSingle', { min }) : t('app.prizeTierTopPhoto', { min, max });
        }
        return null;
    };
    return (
        <details className="text-xs">
            <summary className="font-medium text-base-content/70 cursor-pointer select-none">{t('app.prize')}</summary>
            {tiers.map((tier, index) => {
                const title = typeof tier.title === 'string' ? tier.title.trim() : '';
                // The wire field is typed as an array but is not guaranteed one: read it only when it is.
                const prizes = Array.isArray(tier.prizes) ? prizeItemsText(tier.prizes, t) : '';
                const parts = [title, rankWindowOf(tier), prizes].filter(Boolean);
                if (parts.length === 0) return null;
                return (
                    <div key={index} className="mt-1 flex flex-wrap gap-x-2">
                        {parts.map((part, partIndex) => (
                            <Fragment key={partIndex}>
                                {partIndex > 0 && <span className="sr-only">, </span>}
                                <span className="wrap-anywhere">{part}</span>
                            </Fragment>
                        ))}
                    </div>
                );
            })}
        </details>
    );
}

/**
 * The detailed challenge card body: every stat and every action. All values
 * are derived by the parent ChallengeCard (see utils/challengeCardView) and
 * passed in, so this layout and the compact tile never disagree.
 */
export function ChallengeCardDetail({
    challenge,
    view,
    badgeRowProps,
    timeRemaining,
    timezone,
    actions,
    hasCompactOverride,
    onToggleCompact,
    boostWarning,
    turboWarning,
    deadlineActions,
    scenarioStatus,
    swapBacks,
    entryPins,
    bankroll,
    onVoteComplete,
    onCurrencySpent,
}: {
    challenge: Challenge;
    view: ChallengeCardView;
    badgeRowProps: ChallengeBadgeRowProps;
    timeRemaining: TimeRemaining;
    timezone: string;
    actions: ChallengeCardActionSet;
    hasCompactOverride: boolean;
    onToggleCompact: () => void | Promise<void>;
    boostWarning: string | null;
    turboWarning: string | null;
    deadlineActions: DeadlineAction[];
    scenarioStatus: ReturnType<typeof useScenarioStatusModule.useScenarioStatus>;
    swapBacks: SwapBackOffers;
    entryPins: EntryPinsState;
    bankroll: Bankroll | null;
    onVoteComplete: () => void;
    onCurrencySpent: () => void;
}) {
    const { t } = useTranslation();
    const { userProgress } = view;
    const cardTags = stringTags(challenge);
    const prizeTiers = challenge.achievements_and_prizes ?? [];
    const trackBadges: Array<[string, string]> = [];
    if (challenge.top_photographer_enable) trackBadges.push(['🏆', 'app.trackTopPhotographer']);
    if (challenge.top_photo_enable) trackBadges.push(['📷', 'app.trackTopPhoto']);
    if (challenge.guru_pick_enable) trackBadges.push(['⭐', 'app.trackGurusPick']);

    return (
        <div className="space-y-2">
            <DetailHeader
                challenge={challenge}
                badgeRowProps={badgeRowProps}
                actions={actions}
                hasCompactOverride={hasCompactOverride}
                onToggleCompact={onToggleCompact}
            />

            {/* Challenge Statistics — stacks 2-up on phones, 4-up on tablets+. */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                <StatCell label={t('app.entries')}>
                    <div className={STAT_VALUE}>{countText(challenge.entries)}</div>
                </StatCell>
                <StatCell label={t('app.players')}>
                    <div className={STAT_VALUE}>{countText(challenge.players)}</div>
                </StatCell>
                <StatCell label={t('app.votes')}>
                    <div className={STAT_VALUE}>{(challenge.votes ?? 0).toLocaleString()}</div>
                </StatCell>
                <StatCell label={t('app.prize')}>
                    <div className={STAT_VALUE}>{challenge.prizes_worth}</div>
                </StatCell>
            </div>

            {prizeTiers.length > 0 && <PrizesPanel tiers={prizeTiers} />}

            {userProgress &&
                typeof userProgress.votes === 'number' &&
                Number.isInteger(userProgress.votes) &&
                userProgress.votes >= 0 && <UserProgressPanel challenge={challenge} userProgress={userProgress} />}

            <StatusCells
                challenge={challenge}
                view={view}
                timeRemaining={timeRemaining}
                timezone={timezone}
                actions={actions}
            />

            {/* Challenge tags, and what the challenge tracks (top photographer / top photo / Guru's pick). */}
            {(cardTags.length > 0 || trackBadges.length > 0) && (
                <div className="flex flex-wrap gap-1">
                    {cardTags.length > 0 && <ChallengeTagBadges tags={cardTags} />}
                    {trackBadges.map(([icon, key]) => (
                        <span key={key} className="badge badge-ghost badge-sm">
                            <span aria-hidden="true">{icon} </span>
                            {t(key)}
                        </span>
                    ))}
                </div>
            )}

            {view.entries.length > 0 && (
                <EntryDetails
                    challenge={challenge}
                    view={view}
                    swapBacks={swapBacks}
                    entryPins={entryPins}
                    bankroll={bankroll}
                    onVoteComplete={onVoteComplete}
                    onCurrencySpent={onCurrencySpent}
                    onChooseSwap={actions.openSwapPick}
                    timezone={timezone}
                />
            )}

            {/* Boost/turbo conflict — a boost (or won turbo) is available but every
                entry has the other feature or is pinned for it, so it can't be
                placed. The compact tile shows the same state as a one-line note. */}
            {(
                [
                    ['boost', boostWarning],
                    ['turbo', turboWarning],
                ] as const
            ).map(
                ([kind, warning]) =>
                    warning && (
                        // Keyed on which feature it is about, so a reworded warning is not announced as a new one.
                        <div key={kind} className="alert alert-warning py-2 text-xs" role="alert">
                            <span>{warning}</span>
                        </div>
                    ),
            )}

            {/* Advisory timeline of the automation's upcoming deadline
                actions (the compact tile shows only the next one). */}
            <DeadlineTimeline actions={deadlineActions} />
            <ScenarioStatusPanel status={scenarioStatus} challenge={challenge} />
        </div>
    );
}
