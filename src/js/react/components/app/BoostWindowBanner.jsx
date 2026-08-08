import { useTranslation } from '@/contexts/TranslationContext';
import { formatDuration } from '@/utils/formatters';
import { openBoostWindows } from '../../../voting/boostWindow';
import { useTick } from '@/hooks/useTick';
import { ChipListPanel, ChallengeChip } from './ChallengeChips';

/**
 * Compact summary placed above the challenge list naming the challenges whose
 * boost window is open right now. Each entry is a button that smooth-scrolls to
 * the matching ChallengeCard (which carries id="challenge-<id>"). Renders
 * nothing when no boost window is open, so it stays out of the way otherwise.
 */
export function BoostWindowBanner({ challenges }) {
    const { t } = useTranslation();

    // Tick every second only while at least one chip has a live countdown — a
    // window closing drops its chip the moment it expires, and timed chips
    // count down. When every open window is key-unlocked there is nothing
    // time-dependent to refresh, so we run no interval. The enabled flag is
    // derived from the wall clock (the hook's ticked `now` isn't available
    // before the hook runs — enabled feeds the hook, so deriving it from the
    // hook's output would be circular); the two agree: a countdown chip
    // (AVAILABLE with a future timeout) can only exist while the interval is
    // already running, and key-unlocked windows never gain a countdown with
    // passing time. The duplicate openBoostWindows pass is O(n log n) over a
    // handful of challenges — accepted cost of the shared-hook shape.
    const hasCountdown = openBoostWindows(challenges, Math.floor(Date.now() / 1000)).some((c) => c.remaining != null);
    const now = useTick(1000, hasCountdown);

    const open = openBoostWindows(challenges, now);

    if (open.length === 0) return null;

    return (
        <ChipListPanel icon="🚀" label={t('app.boostWindowOpen')} count={open.length}>
            {open.map((c) => (
                <ChallengeChip key={c.id} challengeId={c.id}>
                    <span>{c.title}</span>
                    {c.remaining != null && <span className="opacity-70">· {formatDuration(c.remaining)} left</span>}
                </ChallengeChip>
            ))}
        </ChipListPanel>
    );
}
