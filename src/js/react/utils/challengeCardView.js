import { formatDuration, getBoostStatus, getTurboStatus, isBoostWindowOpen } from '@/utils/formatters';
import { isLowExposure } from '@/utils/challengeAlerts';
import { canKeyUnlock, canSwapEntry, canFillExposure } from '../../voting/currencyActions';

const LEVEL_NAMES = ['', 'POPULAR', 'SKILLED', 'PREMIER', 'ELITE', 'ALL STAR'];

/**
 * The next ranking level and the votes still needed to reach it, or null when
 * the challenge has no level table (flash challenges never do) or the member
 * is already on the top level.
 *
 * @param {object} challenge
 * @returns {{ nextLevel: number, votesNeeded: number, levelName: string } | null}
 */
export function getNextLevelInfo(challenge) {
    const userProgress = challenge.member.ranking.total;
    if (!challenge.ranking_levels || !userProgress || userProgress.level === undefined || challenge.type === 'flash') {
        return null;
    }
    const nextLevel = userProgress.level + 1;
    const threshold = challenge.ranking_levels[`level_${nextLevel}`];
    if (!threshold) return null;
    return {
        nextLevel,
        votesNeeded: threshold - userProgress.votes,
        levelName: LEVEL_NAMES[nextLevel] || `LEVEL ${nextLevel}`,
    };
}

/**
 * Everything the challenge card (detailed and compact) derives from the raw
 * challenge at one `now` tick: stats, alert flags/classes and the action gates.
 * Pure, so the two layouts can never disagree about what a state means.
 *
 * @param {object} challenge
 * @param {{ now: number, bankroll: object|null, autovoteRunning: boolean, autoFillEnabled: boolean }} context
 */
export function deriveChallengeCardView(challenge, { now, bankroll, autovoteRunning, autoFillEnabled }) {
    const member = challenge.member;
    const entries = member.ranking.entries || [];
    const exposureFactor = member.ranking.exposure.exposure_factor;

    // canPlayAutoTurbo flips to true the moment a TIMER cooldown elapses (the
    // card ticks `now` every second) without waiting for an external poll.
    const turboState = member.turbo?.state;
    const turboCooldownPassed =
        turboState === 'TIMER' && typeof member.turbo?.time_to_open === 'number' && member.turbo.time_to_open <= now;
    const challengeStillOpen = challenge.close_time > now;
    const canPlayAutoTurbo =
        challengeStillOpen && (turboState === 'FREE' || turboState === 'IN_PROGRESS' || turboCooldownPassed);

    const slotsRemaining = Math.max(0, (challenge.max_photo_submits || 0) - entries.length);

    // At-a-glance alerts (see utils/challengeAlerts): an open boost window gets
    // a blue ring + pulsing badge, low exposure a red border + badge and a red
    // exposure figure, so the card stands out in a long list without reading it.
    const boostOpen = isBoostWindowOpen(member.boost, now);
    const lowExposure = isLowExposure(challenge, now);

    return {
        member,
        entries,
        exposureFactor,
        boostStatus: getBoostStatus(member.boost),
        turboStatus: getTurboStatus(member.turbo),
        userProgress: member.ranking.total,
        canPlayAutoTurbo,
        slotsRemaining,
        // Manual photo submit (+1 / +N). Hidden while the scheduled autovote
        // loop is active, like the Run button, so it can't race the loop's own
        // auto-submit for the same slot.
        canFill: !autovoteRunning && challengeStillOpen && slotsRemaining > 0,
        boostOpen,
        // Time left in a timed boost window, preformatted for the badge; null
        // for a key-unlocked boost, which has no timer. Ticks with `now`.
        boostTimeLeft:
            boostOpen && member.boost?.state === 'AVAILABLE' && member.boost.timeout > 0
                ? formatDuration(member.boost.timeout - now)
                : null,
        lowExposure,
        exposureClass: lowExposure ? 'text-error font-bold' : '',
        cardAlertClass: `${lowExposure ? 'border-2 border-error' : 'border'}${boostOpen ? ' ring-2 ring-info ring-offset-2 ring-offset-base-100' : ''}`,
        showAutoFillBadge: autoFillEnabled && slotsRemaining > 0,
        // Bankroll-currency actions — shown only when the balance and the
        // challenge both allow them (shared predicates; the main process
        // re-checks the live state before spending).
        showKeyUnlock: canKeyUnlock(challenge, bankroll, now),
        showFillExposure: canFillExposure(challenge, bankroll, now),
        swapAvailable: canSwapEntry(challenge, bankroll, now),
        // Manual "vote to 100%" override. Shown even while the scheduled
        // autovote loop is running so a single challenge can be pushed to 100%
        // without stopping the bot first. Safe to overlap a strategy pass: the
        // manual path (evaluateManualVotingToHundred) bypasses thresholds and
        // the vote is naturally bounded (the API caps exposure at 100%), unlike
        // the full-strategy Run button which stays hidden to avoid racing
        // turbo/boost/fill actions. Both gates read the per-second `now` tick
        // (not a raw Date.now()) so they flip the moment a challenge starts.
        showVoteButton: challenge.start_time < now && exposureFactor < 100,
        // Run button: fires one full auto-strategy cycle for this card. Hidden
        // while the scheduled autovote loop is active to avoid racing
        // concurrent strategy passes for the same challenge.
        showRunButton: !autovoteRunning && challenge.start_time < now,
    };
}
