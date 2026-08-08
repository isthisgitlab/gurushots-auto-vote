import { useState, useEffect } from 'react';
import { useTranslation } from '@/contexts/TranslationContext';
import { formatDuration } from '@/utils/formatters';
import { openBoostWindows } from '../../../voting/boostWindow';
import { scrollToChallenge } from '@/utils/scrollToChallenge';

/**
 * Compact summary placed above the challenge list naming the challenges whose
 * boost window is open right now. Each entry is a button that smooth-scrolls to
 * the matching ChallengeCard (which carries id="challenge-<id>"). Renders
 * nothing when no boost window is open, so it stays out of the way otherwise.
 */
export function BoostWindowBanner({ challenges }) {
    const { t } = useTranslation();

    const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

    const open = openBoostWindows(challenges, now);

    // Tick every second only while at least one chip has a live countdown — a
    // window closing drops its chip the moment it expires, and timed chips
    // count down. When every open window is key-unlocked there is nothing
    // time-dependent to refresh, so we run no interval.
    const hasCountdown = open.some((c) => c.remaining != null);
    useEffect(() => {
        if (!hasCountdown) return undefined;
        const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
        return () => clearInterval(id);
    }, [hasCountdown]);

    if (open.length === 0) return null;

    return (
        <div className="rounded-lg border border-base-300 bg-base-100 p-2 mb-4">
            <div className="text-sm font-medium mb-2">
                <span aria-hidden="true">🚀</span> {t('app.boostWindowOpen')} ({open.length})
            </div>
            <div className="flex flex-wrap gap-2">
                {open.map((c) => (
                    <button
                        key={c.id}
                        type="button"
                        className="btn btn-xs h-auto whitespace-normal text-left"
                        onClick={() => scrollToChallenge(c.id)}
                    >
                        <span>{c.title}</span>
                        {c.remaining != null && (
                            <span className="opacity-70">· {formatDuration(c.remaining)} left</span>
                        )}
                    </button>
                ))}
            </div>
        </div>
    );
}
