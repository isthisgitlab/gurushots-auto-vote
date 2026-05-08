import { useState, useEffect } from 'react';
import { useTranslation } from '@/contexts/TranslationContext';
import { formatEndTime, getBoostStatus, getTurboStatus, getLevelStatus } from '@/utils/formatters';
import { useTurbo } from '@/api/useTurbo';
import { useFillChallenge } from '@/api/useFillChallenge';
import { VoteButton } from './VoteButton';
import { EntryBadge } from './EntryBadge';

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
    const [hasCustomSettings, setHasCustomSettings] = useState(false);
    const [onlyBoost, setOnlyBoost] = useState(false);
    const [autoFillEnabled, setAutoFillEnabled] = useState(false);
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

    // Check for custom settings
    useEffect(() => {
        const checkSettings = async () => {
            try {
                const schema = await window.api.getSettingsSchema();
                for (const [key, config] of Object.entries(schema)) {
                    if (!config.perChallenge) continue;
                    const override = await window.api.getChallengeOverride(key, challenge.id.toString());
                    if (override !== null) {
                        setHasCustomSettings(true);
                        break;
                    }
                }

                const boostOnly = await window.api.getEffectiveSetting('onlyBoost', challenge.id.toString());
                setOnlyBoost(boostOnly);

                const fillOn = await window.api.getEffectiveSetting('autoFill', challenge.id.toString());
                setAutoFillEnabled(fillOn === true);
            } catch {
                // Ignore errors
            }
        };
        checkSettings();
    }, [challenge.id]);

    // Show vote button logic
    const showVoteButton =
        (!autovoteRunning || (autovoteRunning && onlyBoost)) &&
        challenge.start_time < Math.floor(Date.now() / 1000) &&
        exposureFactor < 100;

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

    const handleOpenUrl = async () => {
        if (challenge.url) {
            await window.api.openExternalUrl(`https://gurushots.com/challenge/${challenge.url}`);
        }
    };

    return (
        <div className="border rounded-lg p-3 mb-3 bg-base-100">
            <div className="space-y-2">
                {/* Title and Description */}
                <div className="flex justify-between items-start">
                    <div className="flex-1">
                        <h3 className="font-bold text-base">{challenge.title}</h3>
                        {/* Welcome message from API - preserving existing behavior from vanilla JS */}
                        <div
                            className="text-xs text-base-content/60"
                            dangerouslySetInnerHTML={{ __html: challenge.welcome_message }}
                        />
                        {/* Challenge Type Badges */}
                        <div className="flex gap-1 mt-1">
                            {challenge.type && (
                                <span className="badge badge-xs badge-warning">{challenge.type.toUpperCase()}</span>
                            )}
                            {!challenge.type && challenge.badge && (
                                <span className="badge badge-xs badge-info">{challenge.badge}</span>
                            )}
                            {challenge.max_photo_submits > 1 && (
                                <span className="badge badge-xs badge-warning">
                                    {challenge.max_photo_submits} {t('app.photos')}
                                </span>
                            )}
                            {hasCustomSettings && (
                                <span className="badge badge-xs badge-accent" title="Custom settings configured">
                                    ⚙️
                                </span>
                            )}
                            {autoFillEnabled && (
                                <span className="badge badge-xs badge-accent" title={t('app.autoFill')}>
                                    📥 {t('app.autoFillBadge')}
                                </span>
                            )}
                        </div>
                        {/* Challenge URL */}
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
                    <div className="flex gap-2">
                        {showVoteButton && (
                            <VoteButton
                                challengeId={challenge.id}
                                challengeTitle={challenge.title}
                                onVoteComplete={onVoteComplete}
                            />
                        )}
                        {challenge.type !== 'flash' && (
                            <button
                                className="btn btn-ghost btn-sm"
                                onClick={() => onSettingsClick(challenge.id, challenge.title)}
                                title="Challenge Settings"
                            >
                                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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
                            </button>
                        )}
                    </div>
                </div>

                {/* Challenge Statistics — stacks 2-up on phones, 4-up on tablets+ */}
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

                {/* User Progress */}
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

                {/* Challenge Stats Row — stacks 2-up on phones, 3-up on small tablets, 6-up on desktop */}
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-2 text-xs">
                    <div className="text-center p-2 bg-base-200 rounded">
                        <div className="font-medium">{t('app.time')}</div>
                        <div className={timeRemaining === 'Ended' ? 'text-error' : 'text-success'}>{timeRemaining}</div>
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
                                title={
                                    turboError ||
                                    (autovoteRunning ? t('app.autoTurboRunsWithAutovote') : t('app.playAutoTurbo'))
                                }
                            >
                                {playingTurbo ? (
                                    <span className="loading loading-spinner loading-xs" />
                                ) : (
                                    <>🎯 {t('app.earnTurbo')}</>
                                )}
                            </button>
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
                                    title={fillError || t('app.addOnePhoto')}
                                >
                                    {filling ? <span className="loading loading-spinner loading-xs" /> : '+1'}
                                </button>
                                {slotsRemaining > 1 && (
                                    <button
                                        className="btn btn-xs btn-warning"
                                        onClick={() => handleFill('all')}
                                        disabled={filling || autovoteRunning}
                                        title={t('app.fillAllPhotos')}
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

                {/* Entries */}
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
                                />
                            ))}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
