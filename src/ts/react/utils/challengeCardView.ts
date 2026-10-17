import type { Bankroll, Challenge } from '../../types/gurushots';
import type { RankedChallenge } from '../../types/rendererUtils';
import { formatDuration, getBoostStatus, getTurboStatus, isBoostWindowOpen } from '@/utils/formatters';
import { isLowExposure } from '@/utils/challengeAlerts';
import { canKeyUnlock, canSwapEntry, canFillExposure } from '../../voting/currencyActions';
import { finiteOr } from '../../numbers';

const LEVEL_NAMES = ['', 'POPULAR', 'SKILLED', 'PREMIER', 'ELITE', 'ALL STAR'];

/**
 * The next ranking level and the votes still needed to reach it, or null when
 * the challenge has no level table (flash challenges never do) or the member
 * is already on the top level.
 *
 * @param challenge - An active challenge; its member standing is read unguarded.
 */
export function getNextLevelInfo(
    challenge: Challenge,
): { nextLevel: number; votesNeeded: number; levelName: string } | null {
    const userProgress = (challenge as RankedChallenge).member.ranking.total;
    if (!challenge.ranking_levels || !userProgress || userProgress.level === undefined || challenge.type === 'flash') {
        return null;
    }
    const nextLevel = userProgress.level + 1;
    const threshold = challenge.ranking_levels[`level_${nextLevel}`];
    if (!threshold) return null;
    return {
        nextLevel,
        votesNeeded: threshold - finiteOr(userProgress.votes, 0),
        levelName: LEVEL_NAMES[nextLevel] || `LEVEL ${nextLevel}`,
    };
}

/**
 * Whether anything on the card counts down to a second-by-second change at `now`: a turbo cooldown that has yet to
 * elapse, or a timed boost window with time left (its remaining time is on the card's badge). When neither is
 * true the card needs no per-second re-render.
 *
 * @param challenge - An active challenge.
 * @param now - Unix seconds
 */
export function needsSecondTick(challenge: Challenge, now: number): boolean {
    const member = (challenge as RankedChallenge).member;
    const turbo = member?.turbo;
    const boost = member?.boost;
    const turboCooldown =
        turbo?.state === 'TIMER' && typeof turbo.time_to_open === 'number' && turbo.time_to_open > now;
    const timedBoost = boost?.state === 'AVAILABLE' && finiteOr(boost.timeout, 0) > now;
    return turboCooldown || timedBoost;
}

/**
 * The next second at which a start- or close-gated control on the card flips, or null when none is ahead: the first
 * second after `start_time` (the vote and run buttons need the challenge started) and `close_time` itself (filling needs
 * it still open). The card re-renders at that second, so those buttons flip on time with no per-second tick.
 *
 * @param challenge - An active challenge.
 * @param now - Unix seconds
 */
export function nextBoundaryFlip(challenge: Challenge, now: number): number | null {
    const ahead = [challenge.start_time + 1, challenge.close_time].filter(
        (flip) => Number.isFinite(flip) && flip > now,
    );
    return ahead.length > 0 ? Math.min(...ahead) : null;
}

/**
 * Everything the challenge card (detailed and compact) derives from the raw
 * challenge at one `now` tick: stats, alert flags/classes and the action gates.
 * Pure, so the two layouts can never disagree about what a state means.
 *
 * @param challenge - An active challenge; its member standing is read unguarded.
 */
export function deriveChallengeCardView(
    challenge: Challenge,
    {
        now,
        bankroll,
        autovoteRunning,
        autoSubmitEnabled,
        manualPhotosOnly,
    }: {
        now: number;
        bankroll: Bankroll | null;
        autovoteRunning: boolean;
        autoSubmitEnabled: boolean;
        manualPhotosOnly: boolean;
    },
) {
    const member = (challenge as RankedChallenge).member;
    const entries = member.ranking.entries || [];
    const exposureFactor = member.ranking.exposure.exposure_factor;

    // canPlayAutoTurbo flips to true the moment a TIMER cooldown elapses (the
    // card ticks `now` every second while one runs) without waiting for an external poll.
    const turboState = member.turbo?.state;
    const turboCooldownPassed =
        turboState === 'TIMER' && typeof member.turbo?.time_to_open === 'number' && member.turbo.time_to_open <= now;
    const challengeStillOpen = challenge.close_time > now;
    const canPlayAutoTurbo =
        challengeStillOpen &&
        member.turbo?.mode === 'classic' &&
        (turboState === 'FREE' || turboState === 'IN_PROGRESS' || turboCooldownPassed);

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
        // Manual photo submit (+1 / +N), shown whenever the challenge is open
        // with a free slot, autovote running or not: the fill handler fetches
        // the live challenge before submitting, the loop's own scheduled fill
        // re-checks live state before its submit, and a submit past the slot
        // cap is rejected by the API ("Submit rejected").
        canFill: challengeStillOpen && slotsRemaining > 0,
        boostOpen,
        // Time left in a timed boost window, preformatted for the badge; null
        // for a key-unlocked boost, which has no timer. Ticks with `now`.
        boostTimeLeft:
            boostOpen && member.boost?.state === 'AVAILABLE' && finiteOr(member.boost.timeout, 0) > 0
                ? formatDuration(finiteOr(member.boost.timeout, 0) - now)
                : null,
        lowExposure,
        exposureClass: lowExposure ? 'text-error font-bold' : '',
        cardAlertClass: `${lowExposure ? 'border-2 border-error' : 'border'}${boostOpen ? ' ring-2 ring-info ring-offset-2 ring-offset-base-100' : ''}`,
        // Manual Only stops the auto-submit, so its badge gives way to the manual-only one.
        showAutoSubmitBadge: autoSubmitEnabled && !manualPhotosOnly && slotsRemaining > 0,
        showManualPhotosBadge: manualPhotosOnly,
        // Manual Only: the card's notes about pins that are not applying are hidden, since a pin only steers
        // the automatic spends, which do not run there.
        manualOnly: manualPhotosOnly,
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
        // turbo/boost/fill actions. Both gates read the card's `now` (not a raw
        // Date.now()), and the card re-renders at the start boundary
        // (nextBoundaryFlip), so they flip the moment a challenge starts.
        showVoteButton: challenge.start_time < now && exposureFactor < 100,
        // Run button: fires one full auto-strategy cycle for this card. Hidden
        // while the scheduled autovote loop is active to avoid racing
        // concurrent strategy passes for the same challenge. Also hidden under
        // Manual Only: Run applies the automatic rules, which do nothing there.
        showRunButton: !autovoteRunning && challenge.start_time < now && !manualPhotosOnly,
    };
}
