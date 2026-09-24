import { useMemo } from 'react';
import { useTranslation } from '@/contexts/TranslationContext';
import { formatEndTime, getLevelStatus } from '@/utils/formatters';
import { getNextLevelInfo } from '@/utils/challengeCardView';
import { sanitizeWelcomeMessage } from '@/utils/sanitizeWelcomeMessage';
import { DeadlineTimeline } from './DeadlineTimeline';
import { EntryBadge } from './EntryBadge';
import { ChallengeBadgeRow } from './ChallengeBadgeRow';
import { CardDensityToggle } from './CardDensityToggle';
import { FillButtons } from './ChallengeCardActions';

/**
 * One labelled cell of the detailed card's stat grids.
 */
function StatCell({ label, children }) {
    return (
        <div className="text-center p-2 bg-base-200 rounded">
            <div className="font-medium">{label}</div>
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
function DetailHeader({ challenge, badgeRowProps, actions, hasCompactOverride, onToggleCompact }) {
    const sanitizedWelcome = useMemo(
        () => sanitizeWelcomeMessage(challenge.welcome_message),
        [challenge.welcome_message],
    );

    // Only reachable from the URL row, which renders only when challenge.url is set.
    const handleOpenUrl = async () => {
        await window.api.openExternalUrl(`https://gurushots.com/challenge/${challenge.url}`);
    };

    return (
        <div className="flex flex-col gap-2">
            <div className="min-w-0">
                <h3 className="font-bold text-base truncate">{challenge.title}</h3>
                {/* Welcome message. truncate prevents long welcome text from forcing the card wider. sanitizeWelcomeMessage strips medium-editor toolbar leakage and allowlists safe tags. */}
                {sanitizedWelcome && (
                    <div
                        className="text-xs text-base-content/60 truncate"
                        dangerouslySetInnerHTML={{ __html: sanitizedWelcome }}
                    />
                )}
                <ChallengeBadgeRow {...badgeRowProps} />
                {challenge.url && (
                    <div className="text-xs text-base-content/40 mt-1">
                        <button
                            onClick={handleOpenUrl}
                            className="font-mono hover:text-latvian hover:underline text-left"
                        >
                            gurushots.com/challenge/{challenge.url}
                        </button>
                    </div>
                )}
            </div>
            <div className="flex flex-wrap gap-1 shrink-0">
                {actions.voteButton}
                {actions.runButton}
                <CardDensityToggle isCompact={false} hasOverride={hasCompactOverride} onToggle={onToggleCompact} />
                {actions.settingsButton}
            </div>
        </div>
    );
}

/**
 * User progress — full bar + level + next-level info. Rendered only once the
 * member has votes in the challenge.
 */
function UserProgressPanel({ challenge, userProgress }) {
    const { t } = useTranslation();
    const nextLevelInfo = getNextLevelInfo(challenge);

    return (
        <div className="bg-base-200 rounded p-2">
            <div className="flex justify-between items-center mb-1">
                <span className="text-xs font-medium">{t('app.yourProgress')}</span>
                <span
                    className={`badge badge-xs ${getLevelStatus(userProgress.level, userProgress.level_name).colorClass}`}
                >
                    {userProgress.level_name} {userProgress.level}
                </span>
            </div>
            <div className="flex justify-between text-xs mb-1">
                <span>
                    {t('app.rank')} {userProgress.rank} {t('app.of')} {challenge.players}
                </span>
                <span>
                    {userProgress.votes} {t('app.votes')}
                </span>
            </div>
            <progress className="progress progress-latvian w-full" value={userProgress.percent} max="100" />
            {challenge.type !== 'flash' && (
                <div className="text-xs text-base-content/60 mt-1">{userProgress.next_message}</div>
            )}
            {nextLevelInfo && (
                <div className="text-xs text-base-content/60 mt-1">
                    {t('app.next')}: {nextLevelInfo.levelName} ({nextLevelInfo.votesNeeded} {t('app.votesNeeded')})
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
function StatusCells({ challenge, view, timeText, timezone, actions, autovoteRunning }) {
    const { t } = useTranslation();
    const { turboError, fillError } = actions;

    return (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-2 text-xs">
            <StatCell label={t('app.time')}>
                <div className={timeText === 'Ended' ? 'text-error' : 'text-success'}>{timeText}</div>
            </StatCell>
            <StatCell label={t('app.ends')}>
                <div className="text-xs">{formatEndTime(challenge.close_time, timezone)}</div>
            </StatCell>
            <StatCell label={t('app.exposure')}>
                <div className={view.exposureClass}>{view.exposureFactor}%</div>
                {actions.fillExposureButton}
            </StatCell>
            <StatCell label={t('app.boost')}>
                <div className={view.boostStatus.colorClass}>{view.boostStatus.text}</div>
                {actions.keyUnlockButton}
            </StatCell>
            <StatCell label={t('app.turbo')}>
                <div className={view.turboStatus.colorClass}>{view.turboStatus.text}</div>
                {actions.earnTurboButton}
                {turboError && <div className="text-error text-xs mt-1">{turboError}</div>}
                {!turboError && view.canPlayAutoTurbo && autovoteRunning && (
                    <div className="text-base-content/60 text-xs mt-1">{t('app.autoTurboRunsWithAutovote')}</div>
                )}
            </StatCell>
            <StatCell label={t('app.yourEntries')}>
                <div>
                    {view.entries.length}/{challenge.max_photo_submits}
                </div>
                {view.canFill && (
                    <div className="flex gap-1 mt-1 justify-center">
                        <FillButtons {...actions.fillButtonProps} />
                    </div>
                )}
                {fillError && <div className="text-error text-xs mt-1">{fillError}</div>}
            </StatCell>
        </div>
    );
}

/**
 * Entry details — entry-level boost / turbo badges and actions.
 */
function EntryDetails({ challenge, view, swapBacks, bankroll, onVoteComplete, onCurrencySpent }) {
    const { t } = useTranslation();

    return (
        <div>
            <div className="text-xs text-base-content/60 mb-1">{t('app.entryDetails')}:</div>
            <div className="flex flex-wrap gap-1">
                {view.entries.map((entry) => (
                    <EntryBadge
                        key={entry.id}
                        entry={entry}
                        challengeId={challenge.id}
                        boostAvailable={view.boostStatus.text.includes('Available')}
                        turboAvailable={view.member.turbo?.state === 'WON'}
                        onBoostApplied={onVoteComplete}
                        onTurboApplied={onVoteComplete}
                        swapAvailable={view.swapAvailable}
                        bankroll={bankroll}
                        onSwapped={onCurrencySpent}
                        swapBack={swapBacks.find((r) => r.currentId === String(entry.id)) ?? null}
                    />
                ))}
            </div>
        </div>
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
    timeText,
    timezone,
    actions,
    autovoteRunning,
    hasCompactOverride,
    onToggleCompact,
    boostBlocked,
    deadlineActions,
    swapBacks,
    bankroll,
    onVoteComplete,
    onCurrencySpent,
}) {
    const { t } = useTranslation();
    const { userProgress } = view;

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
                    <div>{challenge.entries.toLocaleString()}</div>
                </StatCell>
                <StatCell label={t('app.players')}>
                    <div>{challenge.players.toLocaleString()}</div>
                </StatCell>
                <StatCell label={t('app.votes')}>
                    <div>{challenge.votes.toLocaleString()}</div>
                </StatCell>
                <StatCell label={t('app.prize')}>
                    <div>{challenge.prizes_worth}</div>
                </StatCell>
            </div>

            {userProgress && userProgress.votes > 0 && (
                <UserProgressPanel challenge={challenge} userProgress={userProgress} />
            )}

            <StatusCells
                challenge={challenge}
                view={view}
                timeText={timeText}
                timezone={timezone}
                actions={actions}
                autovoteRunning={autovoteRunning}
            />

            {/* Challenge Tags */}
            {challenge.tags && challenge.tags.length > 0 && (
                <div className="flex flex-wrap gap-1">
                    {challenge.tags.map((tag, index) => (
                        <span key={index} className="badge badge-ghost badge-xs">
                            {tag}
                        </span>
                    ))}
                </div>
            )}

            {view.entries.length > 0 && (
                <EntryDetails
                    challenge={challenge}
                    view={view}
                    swapBacks={swapBacks}
                    bankroll={bankroll}
                    onVoteComplete={onVoteComplete}
                    onCurrencySpent={onCurrencySpent}
                />
            )}

            {/* Boost/turbo conflict — a boost is available but the only entry
                already has Turbo, so it can't be placed. The compact tile
                shows the same state as a one-line note. */}
            {boostBlocked && (
                <div className="alert alert-warning py-2 text-xs" role="alert">
                    <span>{t('app.boostConflictWarning')}</span>
                </div>
            )}

            {/* Advisory timeline of the automation's upcoming deadline
                actions (the compact tile shows only the next one). */}
            <DeadlineTimeline actions={deadlineActions} />
        </div>
    );
}
