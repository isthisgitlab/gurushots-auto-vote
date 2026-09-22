import { useMemo } from 'react';
import { useTranslation } from '@/contexts/TranslationContext';
import { formatEndTime, getBoostStatus, getTurboStatus, getLevelStatus, isBoostWindowOpen } from '@/utils/formatters';
import { isLowExposure } from '@/utils/challengeAlerts';
import { sanitizeWelcomeMessage } from '@/utils/sanitizeWelcomeMessage';
import { useTurbo } from '@/api/useTurbo';
import { useFillChallenge } from '@/api/useFillChallenge';
import { useDeadlineActions } from '@/api/useDeadlineActions';
import { DeadlineTimeline } from './DeadlineTimeline';
import { useChallengeSettings } from '@/hooks/useChallengeSettings';
import { useTick } from '@/hooks/useTick';
import { useAutoClear } from '@/hooks/useAutoClear';
import { VoteButton } from './VoteButton';
import { RunButton } from './RunButton';
import { EntryBadge } from './EntryBadge';
import { ChallengeBadgeRow } from './ChallengeBadgeRow';
import { CardDensityToggle } from './CardDensityToggle';
import { ChallengeCardCompact } from './ChallengeCardCompact';
import { CurrencyCellButton } from './CurrencyActionButton';
import { canKeyUnlock, canSwapEntry, canFillExposure } from '../../../voting/currencyActions';

const TURBO_ERROR_DISPLAY_MS = 5000;
const FILL_ERROR_DISPLAY_MS = 5000;

/**
 * "Earn turbo" mini-game button in the detailed turbo cell. Locked while a
 * play is in flight or the autovote loop (which plays turbo itself) is running.
 */
function EarnTurboButton({ turboError, playingTurbo, disabled, onPlay, label }) {
    return (
        <button
            className={`btn btn-xs mt-1 ${turboError ? 'btn-error' : 'btn-info'}`}
            onClick={onPlay}
            disabled={disabled}
        >
            {playingTurbo ? <span className="loading loading-spinner loading-xs" /> : <>🎯 {label}</>}
        </button>
    );
}

/**
 * "+1" fill button in the detailed entries cell.
 */
function FillOneButton({ fillError, filling, autovoteRunning, onFill }) {
    return (
        <button
            className={`btn btn-xs ${fillError ? 'btn-error' : 'btn-info'}`}
            onClick={onFill}
            disabled={filling || autovoteRunning}
        >
            {filling ? <span className="loading loading-spinner loading-xs" /> : '+1'}
        </button>
    );
}

/**
 * Challenge card. Renders either the full detailed card (every stat and every
 * action) or, when compactCards is on for this challenge, the read-only
 * ChallengeCardCompact tile. The root element is the grid item in
 * ChallengesSection's #challenges-container: a detailed card spans the full
 * row, compact tiles share one.
 */
export function ChallengeCard({
    challenge,
    defaultCompact = false,
    timeRemaining,
    timezone,
    autovoteRunning,
    onVoteComplete,
    onSettingsClick,
    bankroll = null,
    onCurrencySpent,
}) {
    const { t } = useTranslation();
    const { hasCustomSettings, autoFillEnabled, isCompact, hasCompactOverride, toggleCompact } = useChallengeSettings(
        challenge.id,
        defaultCompact,
    );
    const { playAutoTurbo, loading: playingTurbo, error: turboError, clearError: clearTurboError } = useTurbo();
    const { fillNow, loading: filling, error: fillError, clearError: clearFillError } = useFillChallenge();
    // Advisory deadline-action preview + boost/turbo conflict flag (read-only,
    // computed main-side). Failure yields empty actions / false — the card just
    // renders without them, never an error surface.
    const { actions: deadlineActions, boostBlocked } = useDeadlineActions(challenge);

    // Tick once a second — only meaningful when this challenge is in TIMER
    // state and we want canPlayAutoTurbo to flip to true the moment the
    // cooldown elapses without waiting for an external poll.
    const now = useTick(1000);

    // timeRemaining is a Signal<string> from useTimers — reading .value here
    // subscribes this card so the countdown text stays live. The badges smoke
    // test passes a plain string, so fall back to the raw value (or a loading
    // placeholder) when it isn't a signal.
    const timeText =
        timeRemaining && typeof timeRemaining === 'object' ? timeRemaining.value : timeRemaining || t('common.loading');

    const member = challenge.member;
    const entries = member.ranking.entries || [];
    const exposureFactor = member.ranking.exposure.exposure_factor;
    const boostStatus = getBoostStatus(member.boost);
    const turboStatus = getTurboStatus(member.turbo);
    const userProgress = member.ranking.total;

    const turboState = member.turbo?.state;
    const turboCooldownPassed =
        turboState === 'TIMER' && typeof member.turbo?.time_to_open === 'number' && member.turbo.time_to_open <= now;
    const challengeStillOpen = challenge.close_time > now;
    const canPlayAutoTurbo =
        challengeStillOpen && (turboState === 'FREE' || turboState === 'IN_PROGRESS' || turboCooldownPassed);

    useAutoClear(turboError, clearTurboError, TURBO_ERROR_DISPLAY_MS);
    useAutoClear(fillError, clearFillError, FILL_ERROR_DISPLAY_MS);

    const handlePlayAutoTurbo = async () => {
        const result = await playAutoTurbo(challenge.id, challenge.title);
        if (result?.success && onVoteComplete) onVoteComplete();
    };

    const handleFill = async (mode) => {
        const result = await fillNow(challenge.id, mode);
        if (result?.success && onVoteComplete) onVoteComplete();
    };

    const slotsRemaining = Math.max(0, (challenge.max_photo_submits || 0) - entries.length);
    const canFill = challengeStillOpen && slotsRemaining > 0;

    // At-a-glance alerts (see utils/challengeAlerts): an open boost window gets
    // a blue ring + pulsing badge, low exposure a red border + badge and a red
    // exposure figure, so the card stands out in a long list without reading it.
    const boostOpen = isBoostWindowOpen(member.boost, now);
    const lowExposure = isLowExposure(challenge, now);
    const exposureClass = lowExposure ? 'text-error font-bold' : '';
    const cardAlertClass = `${lowExposure ? 'border-2 border-error' : 'border'}${boostOpen ? ' ring-2 ring-info ring-offset-2 ring-offset-base-100' : ''}`;

    const showAutoFillBadge = autoFillEnabled && slotsRemaining > 0;

    // Bankroll-currency actions — shown only when the balance and the
    // challenge both allow them (shared predicates; the main process re-checks
    // the live state before spending). Refresh balances + challenges after.
    const showKeyUnlock = canKeyUnlock(challenge, bankroll, now);
    const showFillExposure = canFillExposure(challenge, bankroll, now);
    const swapAvailable = canSwapEntry(challenge, bankroll, now);
    const handleCurrencySpent = onCurrencySpent || onVoteComplete;

    // Manual "vote to 100%" override. Shown even while the scheduled
    // autovote loop is running so a single challenge can be pushed to 100%
    // without stopping the bot first. Safe to overlap a strategy pass: the
    // manual path (evaluateManualVotingToHundred) bypasses thresholds and the
    // vote is naturally bounded (the API caps exposure at 100%), unlike the
    // full-strategy Run button below which stays hidden to avoid racing
    // turbo/boost/fill actions. Both gates read the per-second `now` tick (not
    // a raw Date.now()) so they flip the moment a challenge starts.
    const showVoteButton = challenge.start_time < now && exposureFactor < 100;

    // Run button: fires one full auto-strategy cycle for this card.
    // Hidden while the scheduled autovote loop is active to avoid
    // racing concurrent strategy passes for the same challenge.
    const showRunButton = !autovoteRunning && challenge.start_time < now;

    // Next level info
    const getNextLevelInfo = () => {
        if (
            challenge.ranking_levels &&
            userProgress &&
            userProgress.level !== undefined &&
            challenge.type !== 'flash'
        ) {
            const currentLevel = userProgress.level;
            const nextLevel = currentLevel + 1;
            const nextLevelKey = `level_${nextLevel}`;

            if (challenge.ranking_levels[nextLevelKey]) {
                const votesNeeded = challenge.ranking_levels[nextLevelKey] - userProgress.votes;
                const levelNames = ['', 'POPULAR', 'SKILLED', 'PREMIER', 'ELITE', 'ALL STAR'];
                return {
                    nextLevel,
                    votesNeeded,
                    levelName: levelNames[nextLevel] || `LEVEL ${nextLevel}`,
                };
            }
        }
        return null;
    };

    const nextLevelInfo = getNextLevelInfo();
    const endTime = formatEndTime(challenge.close_time, timezone);
    const sanitizedWelcome = useMemo(
        () => sanitizeWelcomeMessage(challenge.welcome_message),
        [challenge.welcome_message],
    );

    const handleOpenUrl = async () => {
        if (challenge.url) {
            await window.api.openExternalUrl(`https://gurushots.com/challenge/${challenge.url}`);
        }
    };

    // id + scroll-mt make the card a smooth-scroll target for the anchor chips
    // in BoostWindowBanner and ChallengeNav (both go through scrollToChallenge,
    // which looks the card up by this exact id); scroll-mt keeps it off the top
    // edge after scrollIntoView. Keep `challenge-${id}` in sync with
    // scrollToChallenge. Shared by both layouts.
    const cardId = `challenge-${challenge.id}`;
    const cardClass = `${cardAlertClass} rounded-lg p-3 bg-base-100 scroll-mt-4`;
    const badgeRowProps = {
        challenge,
        boostOpen,
        lowExposure,
        exposureFactor,
        showAutoFillBadge,
        hasCustomSettings,
    };

    if (isCompact) {
        return (
            <div id={cardId} className={cardClass}>
                <ChallengeCardCompact
                    challenge={challenge}
                    badgeRowProps={badgeRowProps}
                    timeText={timeText}
                    exposureFactor={exposureFactor}
                    exposureClass={exposureClass}
                    boostStatus={boostStatus}
                    turboStatus={turboStatus}
                    entries={entries}
                    hasCompactOverride={hasCompactOverride}
                    onToggleCompact={toggleCompact}
                    boostBlocked={boostBlocked}
                    deadlineActions={deadlineActions}
                />
            </div>
        );
    }

    return (
        // col-span-full: a detailed card takes a whole row of the grid.
        <div id={cardId} className={`${cardClass} col-span-full`}>
            <div className="space-y-2">
                {/* Header stacks vertically: the title gets the full card
                    width (so it truncates far less), and the action buttons
                    sit on their own row beneath it, wrapping as needed rather
                    than squeezing the title. */}
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
                        {showVoteButton && (
                            <VoteButton
                                challengeId={challenge.id}
                                challengeTitle={challenge.title}
                                onVoteComplete={onVoteComplete}
                            />
                        )}
                        {showRunButton && <RunButton challengeId={challenge.id} onVoteComplete={onVoteComplete} />}
                        <CardDensityToggle
                            isCompact={false}
                            hasOverride={hasCompactOverride}
                            onToggle={toggleCompact}
                        />
                        {challenge.type !== 'flash' && (
                            <button
                                className="btn btn-ghost btn-xs px-1"
                                onClick={() => onSettingsClick(challenge.id, challenge.title)}
                            >
                                <svg className="w-3 h-3 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        strokeWidth="2"
                                        d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
                                    />
                                    <path
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        strokeWidth="2"
                                        d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
                                    />
                                </svg>
                                {t('app.settings')}
                            </button>
                        )}
                    </div>
                </div>

                {/* Challenge Statistics — stacks 2-up on phones, 4-up on tablets+. */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                    <div className="text-center p-2 bg-base-200 rounded">
                        <div className="font-medium">{t('app.entries')}</div>
                        <div>{challenge.entries.toLocaleString()}</div>
                    </div>
                    <div className="text-center p-2 bg-base-200 rounded">
                        <div className="font-medium">{t('app.players')}</div>
                        <div>{challenge.players.toLocaleString()}</div>
                    </div>
                    <div className="text-center p-2 bg-base-200 rounded">
                        <div className="font-medium">{t('app.votes')}</div>
                        <div>{challenge.votes.toLocaleString()}</div>
                    </div>
                    <div className="text-center p-2 bg-base-200 rounded">
                        <div className="font-medium">{t('app.prize')}</div>
                        <div>{challenge.prizes_worth}</div>
                    </div>
                </div>

                {/* User Progress — full bar + level + next-level info. */}
                {userProgress && userProgress.votes > 0 && (
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
                                {t('app.next')}: {nextLevelInfo.levelName} ({nextLevelInfo.votesNeeded}{' '}
                                {t('app.votesNeeded')})
                            </div>
                        )}
                    </div>
                )}

                {/* 6-cell stats grid — stacks 2-up on phones, 3-up on small tablets, 6-up on desktop */}
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-2 text-xs">
                    <div className="text-center p-2 bg-base-200 rounded">
                        <div className="font-medium">{t('app.time')}</div>
                        <div className={timeText === 'Ended' ? 'text-error' : 'text-success'}>{timeText}</div>
                    </div>
                    <div className="text-center p-2 bg-base-200 rounded">
                        <div className="font-medium">{t('app.ends')}</div>
                        <div className="text-xs">{endTime}</div>
                    </div>
                    <div className="text-center p-2 bg-base-200 rounded">
                        <div className="font-medium">{t('app.exposure')}</div>
                        <div className={exposureClass}>{exposureFactor}%</div>
                        {showFillExposure && (
                            <CurrencyCellButton
                                kind="fill"
                                challenge={challenge}
                                bankroll={bankroll}
                                disabled={autovoteRunning}
                                onSpent={handleCurrencySpent}
                            />
                        )}
                    </div>
                    <div className="text-center p-2 bg-base-200 rounded">
                        <div className="font-medium">{t('app.boost')}</div>
                        <div className={boostStatus.colorClass}>{boostStatus.text}</div>
                        {showKeyUnlock && (
                            <CurrencyCellButton
                                kind="key"
                                challenge={challenge}
                                bankroll={bankroll}
                                disabled={autovoteRunning}
                                onSpent={handleCurrencySpent}
                            />
                        )}
                    </div>
                    <div className="text-center p-2 bg-base-200 rounded">
                        <div className="font-medium">{t('app.turbo')}</div>
                        <div className={turboStatus.colorClass}>{turboStatus.text}</div>
                        {canPlayAutoTurbo && (
                            <EarnTurboButton
                                turboError={turboError}
                                playingTurbo={playingTurbo}
                                disabled={playingTurbo || autovoteRunning}
                                onPlay={handlePlayAutoTurbo}
                                label={t('app.earnTurbo')}
                            />
                        )}
                        {turboError && <div className="text-error text-xs mt-1">{turboError}</div>}
                        {!turboError && canPlayAutoTurbo && autovoteRunning && (
                            <div className="text-base-content/60 text-xs mt-1">
                                {t('app.autoTurboRunsWithAutovote')}
                            </div>
                        )}
                    </div>
                    <div className="text-center p-2 bg-base-200 rounded">
                        <div className="font-medium">{t('app.yourEntries')}</div>
                        <div>
                            {entries.length}/{challenge.max_photo_submits}
                        </div>
                        {canFill && (
                            <div className="flex gap-1 mt-1 justify-center">
                                <FillOneButton
                                    fillError={fillError}
                                    filling={filling}
                                    autovoteRunning={autovoteRunning}
                                    onFill={() => handleFill('one')}
                                />
                                {slotsRemaining > 1 && (
                                    <button
                                        className="btn btn-xs btn-warning"
                                        onClick={() => handleFill('all')}
                                        disabled={filling || autovoteRunning}
                                    >
                                        {filling ? (
                                            <span className="loading loading-spinner loading-xs" />
                                        ) : (
                                            `+${slotsRemaining}`
                                        )}
                                    </button>
                                )}
                            </div>
                        )}
                        {fillError && <div className="text-error text-xs mt-1">{fillError}</div>}
                    </div>
                </div>

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

                {/* Entry Details — entry-level boost / turbo badges and actions. */}
                {entries.length > 0 && (
                    <div>
                        <div className="text-xs text-base-content/60 mb-1">{t('app.entryDetails')}:</div>
                        <div className="flex flex-wrap gap-1">
                            {entries.map((entry) => (
                                <EntryBadge
                                    key={entry.id}
                                    entry={entry}
                                    challengeId={challenge.id}
                                    boostAvailable={boostStatus.text.includes('Available')}
                                    turboAvailable={member.turbo?.state === 'WON'}
                                    onBoostApplied={onVoteComplete}
                                    onTurboApplied={onVoteComplete}
                                    swapAvailable={swapAvailable}
                                    bankroll={bankroll}
                                    actionsLocked={autovoteRunning}
                                    onSwapped={handleCurrencySpent}
                                />
                            ))}
                        </div>
                    </div>
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
        </div>
    );
}
