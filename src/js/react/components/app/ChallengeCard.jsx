import { useState, useEffect, useMemo } from 'react';
import { useTranslation } from '@/contexts/TranslationContext';
import { formatEndTime, getBoostStatus, getTurboStatus, getLevelStatus } from '@/utils/formatters';
import { sanitizeWelcomeMessage } from '@/utils/sanitizeWelcomeMessage';
import { useTurbo } from '@/api/useTurbo';
import { useFillChallenge } from '@/api/useFillChallenge';
import { useChallengeSettings } from '@/hooks/useChallengeSettings';
import { VoteButton } from './VoteButton';
import { RunButton } from './RunButton';
import { EntryBadge } from './EntryBadge';
import { StatusBadge } from '../ui/StatusBadge';

const TURBO_ERROR_DISPLAY_MS = 5000;
const FILL_ERROR_DISPLAY_MS = 5000;

/**
 * Challenge card component displaying all challenge details
 */
export function ChallengeCard({
    challenge,
    timeRemaining,
    timezone,
    autovoteRunning,
    onVoteComplete,
    onSettingsClick,
}) {
    const { t } = useTranslation();
    const { hasCustomSettings, onlyBoost, autoFillEnabled, isCompact, hasCompactOverride, toggleCompact } =
        useChallengeSettings(challenge.id);
    const { playAutoTurbo, loading: playingTurbo, error: turboError, clearError: clearTurboError } = useTurbo();
    const { fillNow, loading: filling, error: fillError, clearError: clearFillError } = useFillChallenge();

    // Tick once a second — only meaningful when this challenge is in TIMER
    // state and we want canPlayAutoTurbo to flip to true the moment the
    // cooldown elapses without waiting for an external poll.
    const [now, setNow] = useState(Math.floor(Date.now() / 1000));
    useEffect(() => {
        const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
        return () => clearInterval(id);
    }, []);

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

    useEffect(() => {
        if (!turboError) return undefined;
        const id = setTimeout(clearTurboError, TURBO_ERROR_DISPLAY_MS);
        return () => clearTimeout(id);
    }, [turboError, clearTurboError]);

    useEffect(() => {
        if (!fillError) return undefined;
        const id = setTimeout(clearFillError, FILL_ERROR_DISPLAY_MS);
        return () => clearTimeout(id);
    }, [fillError, clearFillError]);

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

    // Badge row is split into two categories: "logical/state" badges that
    // reflect live challenge/automation state, and an "override/config"
    // badge that marks user-configured overrides. They are styled
    // differently (solid vs muted ghost) and separated so a config marker
    // is never mistaken for a live state.
    const showAutoFillBadge = autoFillEnabled && slotsRemaining > 0;
    const hasLogicalBadge = Boolean(
        challenge.type || challenge.badge || challenge.max_photo_submits > 1 || showAutoFillBadge,
    );

    // Show vote button logic
    const showVoteButton =
        (!autovoteRunning || (autovoteRunning && onlyBoost)) &&
        challenge.start_time < Math.floor(Date.now() / 1000) &&
        exposureFactor < 100;

    // Run button: fires one full auto-strategy cycle for this card.
    // Hidden while the scheduled autovote loop is active to avoid
    // racing concurrent strategy passes for the same challenge.
    const showRunButton = !autovoteRunning && challenge.start_time < Math.floor(Date.now() / 1000);

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

    return (
        // id + scroll-mt make the card a smooth-scroll target for the
        // boost-window banner's anchor chips (scroll-mt is a stock Tailwind
        // utility — keeps the card off the top edge after scrollIntoView).
        <div id={`challenge-${challenge.id}`} className="border rounded-lg p-3 mb-3 bg-base-100 scroll-mt-4">
            <div className="space-y-2">
                {/* Header stacks vertically: the title gets the full card
                    width (so it truncates far less), and the action buttons
                    sit on their own row beneath it, wrapping as needed rather
                    than squeezing the title. */}
                <div className="flex flex-col gap-2">
                    <div className="min-w-0">
                        <h3 className="font-bold text-base truncate">{challenge.title}</h3>
                        {/* Welcome message — hidden in compact mode to keep the card a tight widget. truncate prevents long welcome text from forcing the grid cell wider. sanitizeWelcomeMessage strips medium-editor toolbar leakage and allowlists safe tags. */}
                        {!isCompact && sanitizedWelcome && (
                            <div
                                className="text-xs text-base-content/60 truncate"
                                dangerouslySetInnerHTML={{ __html: sanitizedWelcome }}
                            />
                        )}
                        {/* Challenge badges — logical/state group (solid colors),
                            then a separated override/config marker (muted ghost). */}
                        <div className="flex flex-wrap items-center gap-1 mt-1">
                            {challenge.type && (
                                <StatusBadge variant="warning" size="xs">
                                    🏁 {challenge.type.toUpperCase()}
                                </StatusBadge>
                            )}
                            {!challenge.type && challenge.badge && (
                                <StatusBadge variant="info" size="xs">
                                    🏁 {challenge.badge}
                                </StatusBadge>
                            )}
                            {challenge.max_photo_submits > 1 && (
                                <StatusBadge variant="warning" size="xs">
                                    🖼 {challenge.max_photo_submits} {t('app.photos')}
                                </StatusBadge>
                            )}
                            {showAutoFillBadge && (
                                <StatusBadge variant="success" size="xs">
                                    📥 {t('app.autoFillBadge')}
                                </StatusBadge>
                            )}
                            {hasLogicalBadge && hasCustomSettings && (
                                <span data-testid="badge-divider" className="w-px h-3 bg-base-300 mx-0.5 self-center" />
                            )}
                            {hasCustomSettings && (
                                <StatusBadge variant="ghost" size="xs">
                                    ⚙️ {t('app.customBadge')}
                                </StatusBadge>
                            )}
                        </div>
                        {/* Challenge URL — hidden in compact mode. */}
                        {!isCompact && challenge.url && (
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
                        {/* Per-card density toggle. The icon is filled
                            when this card has its own override so the
                            user can see at-a-glance which cards diverge
                            from the global default. */}
                        <button className="btn btn-ghost btn-xs px-1" onClick={toggleCompact}>
                            <svg
                                className="w-3 h-3 mr-1"
                                fill={hasCompactOverride ? 'currentColor' : 'none'}
                                stroke="currentColor"
                                viewBox="0 0 24 24"
                            >
                                {isCompact ? (
                                    <path
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        strokeWidth="2"
                                        d="M4 8V4m0 0h4M4 4l5 5m11-5h-4m4 0v4m0-4l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4"
                                    />
                                ) : (
                                    <path
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        strokeWidth="2"
                                        d="M9 9V4M9 9H4M9 9L4 4m11 5h5m-5 0V4m0 5l5-5M9 15v5m0-5H4m5 0l-5 5m11-5h5m-5 0v5m0-5l5 5"
                                    />
                                )}
                            </svg>
                            {isCompact ? t('app.details') : t('app.compact')}
                        </button>
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

                {/* Challenge Statistics — stacks 2-up on phones, 4-up on tablets+. Hidden in compact mode. */}
                {!isCompact && (
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
                )}

                {/* User Progress — full bar + level + next-level info; compact mode hides this. */}
                {!isCompact && userProgress && userProgress.votes > 0 && (
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

                {/* Compact mode: single-line widget summary instead of the 6-cell grid. */}
                {isCompact && (
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-base-content/80">
                        <span className={timeText === 'Ended' ? 'text-error font-medium' : 'text-success font-medium'}>
                            ⏱ {timeText}
                        </span>
                        <span>📊 {exposureFactor}%</span>
                        <span className={boostStatus.colorClass}>🚀 {boostStatus.text}</span>
                        <span className={turboStatus.colorClass}>⚡ {turboStatus.text}</span>
                        <span>
                            🖼 {entries.length}/{challenge.max_photo_submits}
                        </span>
                        {canPlayAutoTurbo && (
                            <button
                                className={`btn btn-xs ${turboError ? 'btn-error' : 'btn-info'}`}
                                onClick={handlePlayAutoTurbo}
                                disabled={playingTurbo}
                            >
                                {playingTurbo ? (
                                    <span className="loading loading-spinner loading-xs" />
                                ) : (
                                    `🎯 ${t('app.earnTurbo')}`
                                )}
                            </button>
                        )}
                        {canFill && (
                            <button
                                className={`btn btn-xs ${fillError ? 'btn-error' : 'btn-info'}`}
                                onClick={() => handleFill('one')}
                                disabled={filling || autovoteRunning}
                            >
                                {filling ? <span className="loading loading-spinner loading-xs" /> : '+1'}
                            </button>
                        )}
                        {(turboError || fillError) && <span className="text-error">⚠ {turboError || fillError}</span>}
                    </div>
                )}

                {/* Detailed mode: 6-cell stats grid — stacks 2-up on phones, 3-up on small tablets, 6-up on desktop */}
                {!isCompact && (
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
                            <div>{exposureFactor}%</div>
                        </div>
                        <div className="text-center p-2 bg-base-200 rounded">
                            <div className="font-medium">{t('app.boost')}</div>
                            <div className={boostStatus.colorClass}>{boostStatus.text}</div>
                        </div>
                        <div className="text-center p-2 bg-base-200 rounded">
                            <div className="font-medium">{t('app.turbo')}</div>
                            <div className={turboStatus.colorClass}>{turboStatus.text}</div>
                            {canPlayAutoTurbo && (
                                <button
                                    className={`btn btn-xs mt-1 ${turboError ? 'btn-error' : 'btn-info'}`}
                                    onClick={handlePlayAutoTurbo}
                                    disabled={playingTurbo || autovoteRunning}
                                >
                                    {playingTurbo ? (
                                        <span className="loading loading-spinner loading-xs" />
                                    ) : (
                                        <>🎯 {t('app.earnTurbo')}</>
                                    )}
                                </button>
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
                                    <button
                                        className={`btn btn-xs ${fillError ? 'btn-error' : 'btn-info'}`}
                                        onClick={() => handleFill('one')}
                                        disabled={filling || autovoteRunning}
                                    >
                                        {filling ? <span className="loading loading-spinner loading-xs" /> : '+1'}
                                    </button>
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
                )}

                {/* Challenge Tags — hidden in compact mode. */}
                {!isCompact && challenge.tags && challenge.tags.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                        {challenge.tags.map((tag, index) => (
                            <span key={index} className="badge badge-ghost badge-xs">
                                {tag}
                            </span>
                        ))}
                    </div>
                )}

                {/* Entry Details — entry-level boost / turbo badges.
                    Kept in compact mode because the per-entry boost
                    actions are part of the auto-voter's surface area. */}
                {entries.length > 0 && (
                    <div>
                        {!isCompact && (
                            <div className="text-xs text-base-content/60 mb-1">{t('app.entryDetails')}:</div>
                        )}
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
                                />
                            ))}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
