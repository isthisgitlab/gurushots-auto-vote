import { soonestScheduledStart } from '../scheduledFill';
import { soonestFinalWindowTopUpStart, soonestBoostPrefillStart } from './leadWindows';
import { soonestCurrencyRuleStart, soonestScenarioWake, soonestBoostHoldEnd } from './ruleWakes';
import { resolveEligibleThresholds, anyInWindow, soonestThresholdEntry } from './thresholds';

import type { Challenge } from '../../types/gurushots';
import type { ResolveScheduledFill, ScheduledStart } from '../scheduledFill';
import type {
    CadenceMode,
    LeadWindowStart,
    ThresholdEntry,
    CurrencyRuleStart,
    ScenarioWakeStart,
    BoostHoldEnd,
} from './shared';
import type { ResolveFinalWindowTopUp, ResolveBoostPrefill } from './leadWindows';
import type { ResolveCurrencyAuto, ResolveScenarioWake } from './ruleWakes';
import type { ResolveThreshold } from './thresholds';

/**
 * The whole per-cycle cadence decision (computeNextCycleDelayMs result).
 */
export interface CadenceDecision {
    delayMs: number;
    mode: CadenceMode;
    nextEntry: ThresholdEntry | null;
    nextScheduled: ScheduledStart | null;
    nextFinalWindowTopUp: LeadWindowStart | null;
    nextBoostPrefill: LeadWindowStart | null;
    nextCurrencyRule: CurrencyRuleStart | null;
    nextScenarioWake: ScenarioWakeStart | null;
    nextBoostHold: BoostHoldEnd | null;
}

/**
 * Cap the cadence so the next cycle lands on `boundarySec` instead of sleeping
 * past it — only when the boundary is sooner than the current delay. Floored at
 * `minGapMs` so a boundary that is already here can't busy-loop. Mutates `cadence`.
 *
 * @param boundarySec - Unix timestamp (seconds) of the boundary
 * @param now - Unix timestamp (seconds)
 * @param mode - the mode to report when this boundary wins
 */
const capCadenceToBoundary = (
    cadence: { delayMs: number; mode: CadenceMode },
    boundarySec: number,
    now: number,
    minGapMs: number,
    mode: CadenceMode,
) => {
    const msUntilBoundary = (boundarySec - now) * 1000;
    if (msUntilBoundary < cadence.delayMs) {
        cadence.delayMs = Math.max(minGapMs, msUntilBoundary);
        cadence.mode = mode;
    }
};

/**
 * Single source of cadence truth for every host. Decide how long to wait before
 * the next voting cycle so we never sleep past an upcoming last-minute boundary:
 *
 *   - any challenge already inside its window → fixed fast cadence
 *     (`lastMinuteCheckMinutes`), because deadline timing matters more than the
 *     anti-metronome randomness once we're in the final stretch;
 *   - otherwise the rolled random delay, but capped to the soonest *upcoming*
 *     threshold entry so the next cycle lands on the boundary instead of
 *     overshooting it;
 *   - a far-off boundary (further than one random delay) doesn't shorten the
 *     wait — we just poll at the normal cadence and re-evaluate next cycle, by
 *     which point the boundary is within a random delay and the cap kicks in.
 *
 * Every result is floored at `minGapMs` so an overrun / boundary-already-here
 * case can't busy-loop. Keeping this here (taking already-resolved scalars +
 * the same `resolveThreshold` callback the other helpers use) means the module
 * stays free of settings I/O and the decision is identical on all platforms.
 * Thresholds are resolved in a single pass and both questions (in-window? next
 * entry?) are answered from that one snapshot — no double resolution.
 *
 * When the host opts in (both `resolveScheduledFill` and `timezone` passed),
 * the delay is additionally capped to the soonest upcoming scheduled-fill
 * window start (scheduling/scheduledFill.ts) — whichever boundary is sooner
 * wins. Hosts that don't pass these opts get no scheduled-fill cap.
 * The in-window last-minute branch above takes priority over this cap on
 * purpose: while any challenge is in its final stretch the fixed fast
 * cadence (default 1 min) already re-checks far more often than the
 * scheduled-fill window floor (5 min), so a window start can slip by at
 * most one fast tick — never be missed.
 *
 * @param now - Unix timestamp (seconds)
 * @param opts.normalDelayMs - the random delay already rolled by the host
 * @param opts.lastMinuteCheckMinutes - fixed last-minute cadence (minutes)
 * @param opts.minGapMs - hard floor on the returned delay
 * @param opts.resolveScheduledFill - per-challenge scheduled-fill config resolver (sync or async)
 * @param opts.timezone - IANA zone for the time-of-day form
 * @param opts.resolveFinalWindowTopUp - per-challenge pre-final-window top-up config resolver (sync or async); when passed, the delay is also capped to the soonest upcoming top-up window start
 * @param opts.resolveBoostPrefill - per-challenge pre-boost fill config resolver (sync or async); when passed, the delay is also capped to the soonest upcoming pre-boost window start
 * @param opts.resolveCurrencyAuto - per-challenge currency-automation timing resolver (sync or async); when passed, the delay is also capped to the soonest upcoming key / swap / fill rule opening
 * @param opts.resolveScenarioWake - per-challenge scenario resolver (sync or async); when passed, the delay is also capped to the soonest instant a scenario time condition can flip
 */
export async function computeNextCycleDelayMs(
    challenges: Challenge[],
    now: number,
    {
        resolveThreshold,
        normalDelayMs,
        lastMinuteCheckMinutes,
        minGapMs,
        resolveScheduledFill = null,
        timezone = null,
        resolveFinalWindowTopUp = null,
        resolveBoostPrefill = null,
        resolveCurrencyAuto = null,
        resolveScenarioWake = null,
    }: {
        resolveThreshold: ResolveThreshold;
        normalDelayMs: number;
        lastMinuteCheckMinutes: number;
        minGapMs: number;
        resolveScheduledFill?: ResolveScheduledFill | null;
        timezone?: string | null;
        resolveFinalWindowTopUp?: ResolveFinalWindowTopUp | null;
        resolveBoostPrefill?: ResolveBoostPrefill | null;
        resolveCurrencyAuto?: ResolveCurrencyAuto | null;
        resolveScenarioWake?: ResolveScenarioWake | null;
    },
): Promise<CadenceDecision> {
    const { eligible, thresholds } = await resolveEligibleThresholds(challenges, now, resolveThreshold);
    // A held boost caps even the last-minute cadence: it is typically released
    // inside the final stretch, where one fast tick late still wastes boost time.
    const nextBoostHold = soonestBoostHoldEnd(challenges, now);

    if (anyInWindow(eligible, thresholds, now)) {
        const fast: { delayMs: number; mode: CadenceMode } = {
            delayMs: Math.max(minGapMs, lastMinuteCheckMinutes * 60_000),
            mode: 'last-minute',
        };
        if (nextBoostHold) capCadenceToBoundary(fast, nextBoostHold.startTime, now, minGapMs, 'boost-hold');
        return {
            delayMs: fast.delayMs,
            mode: fast.mode,
            nextEntry: null,
            nextScheduled: null,
            nextFinalWindowTopUp: null,
            nextBoostPrefill: null,
            nextCurrencyRule: null,
            nextScenarioWake: null,
            nextBoostHold,
        };
    }

    // Every boundary below is the same "cap to the soonest upcoming boundary"
    // shape, applied in this fixed order; whichever boundary is sooner wins, and
    // an exact tie keeps the earlier-applied mode.
    const cadence: { delayMs: number; mode: CadenceMode } = { delayMs: normalDelayMs, mode: 'normal' };
    const capTo = (boundarySec: number, mode: CadenceMode) =>
        capCadenceToBoundary(cadence, boundarySec, now, minGapMs, mode);

    const nextEntry = soonestThresholdEntry(eligible, thresholds, now);
    if (nextEntry) capTo(nextEntry.entryTime, 'approaching');

    const nextScheduled =
        resolveScheduledFill && timezone
            ? await soonestScheduledStart(eligible, now, resolveScheduledFill, timezone)
            : null;
    if (nextScheduled) capTo(nextScheduled.startTime, 'scheduled');

    const nextFinalWindowTopUp = resolveFinalWindowTopUp
        ? await soonestFinalWindowTopUpStart(eligible, now, resolveFinalWindowTopUp)
        : null;
    if (nextFinalWindowTopUp) capTo(nextFinalWindowTopUp.startTime, 'pre-final-window');

    const nextBoostPrefill = resolveBoostPrefill
        ? await soonestBoostPrefillStart(eligible, now, resolveBoostPrefill)
        : null;
    if (nextBoostPrefill) capTo(nextBoostPrefill.startTime, 'pre-boost');
    if (nextBoostHold) capTo(nextBoostHold.startTime, 'boost-hold');

    // Currency rules consider every still-open challenge (flash included), not
    // just the threshold-eligible set.
    const nextCurrencyRule = resolveCurrencyAuto
        ? await soonestCurrencyRuleStart(challenges, now, resolveCurrencyAuto)
        : null;
    if (nextCurrencyRule) capTo(nextCurrencyRule.startTime, 'currency-rule');

    // Scenario boundaries likewise consider every still-open challenge.
    const nextScenarioWake = resolveScenarioWake
        ? await soonestScenarioWake(challenges, now, resolveScenarioWake)
        : null;
    if (nextScenarioWake) capTo(nextScenarioWake.startTime, 'scenario');

    return {
        delayMs: cadence.delayMs,
        mode: cadence.mode,
        nextEntry,
        nextScheduled,
        nextFinalWindowTopUp,
        nextBoostPrefill,
        nextCurrencyRule,
        nextScenarioWake,
        nextBoostHold,
    };
}
