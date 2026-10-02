/** The normal-vs-threshold wait decision and its plain-random-cadence error fallback. */

import { getRandomCheckFrequencyMs, anchoredWaitMs, MIN_CYCLE_GAP_MS, OFFLINE_RETRY_MS } from '../randomDelay';
import { computeNextCycleDelayMs } from '../thresholdWindow';
import { DEFAULT_TIMEZONE } from '../../settings/uiDefaults';

import type { ActiveChallengesResponse, Challenge } from '../../types/gurushots';
import type { CadenceDecision } from '../thresholdWindow';
import type { CadenceChainDeps, CycleResult } from './types';

/**
 * Canonical warning emitted when deciding the next delay fails and the chain
 * falls back to the plain random cadence. Exported so each host's error log
 * keeps its exact shape (the CLI logs the bare message + a debug
 * line; the GUI appends `: ${err.message}` over IPC) without re-typing it.
 */
export const DECISION_ERROR_MESSAGE = 'Error computing next cycle delay; using normal cadence';

// OFFLINE_RETRY_MS (the normal-mode wait ceiling applied while the API is
// unreachable) is defined in ./randomDelay alongside the other cadence timing
// constants so the Android headless loop can share it without importing the
// chain; imported above, and re-exported by the ../cadenceChain facade for
// callers/tests.

/**
 * Normal-mode wait: anchored to the previous cycle's start, and — when this
 * re-arm's own fetch failed (API still down) — capped to a short retry so
 * recovery tracks reconnection, not the full (possibly very long) normal
 * cadence. Only reachable in normal mode: a failed fetch yields an empty list,
 * and an empty list never has a threshold/scheduled window to approach.
 *
 * @param delayMs - the decided delay between cycle starts
 */
const normalWaitMs = (delayMs: number, previousCycleStartMs: number | null, fetchFailed: boolean): number => {
    const waitMs = anchoredWaitMs(delayMs, previousCycleStartMs);
    return fetchFailed ? Math.min(waitMs, OFFLINE_RETRY_MS) : waitMs;
};

/**
 * The cadence log line for a boundary-driven (non-normal) decision.
 *
 * @param decision - computeNextCycleDelayMs result
 */
const describeBoundaryCadence = (decision: CadenceDecision, waitMs: number): string => {
    const inSeconds = `next cycle in ${Math.round(waitMs / 1000)}s`;
    switch (decision.mode) {
        case 'last-minute':
            return `⏰ Last-minute cadence — next cycle in ${(waitMs / 60_000).toFixed(2)} min`;
        case 'scheduled':
            return `⏰ Approaching scheduled fill for "${decision.nextScheduled?.challengeTitle}" (${decision.nextScheduled?.form}) — ${inSeconds}`;
        case 'pre-boost':
            return `⏰ Approaching pre-boost fill for "${decision.nextBoostPrefill?.challengeTitle}" — ${inSeconds} (capped to the ${decision.nextBoostPrefill?.leadMin}m pre-boost boundary)`;
        case 'boost-hold':
            return `⏰ Held boost for "${decision.nextBoostHold?.challengeTitle}" becomes due — ${inSeconds}`;
        case 'currency-rule':
            return `⏰ Approaching automatic ${decision.nextCurrencyRule?.action} rule for "${decision.nextCurrencyRule?.challengeTitle}" — ${inSeconds}`;
        case 'scenario':
            return `⏰ Approaching a scenario step for "${decision.nextScenarioWake?.challengeTitle}" (phase ${decision.nextScenarioWake?.phase}) — ${inSeconds}`;
        case 'pre-final-window':
            return `⏰ Approaching pre-final-window top-up for "${decision.nextFinalWindowTopUp?.challengeTitle}" — ${inSeconds} (capped to the ${decision.nextFinalWindowTopUp?.leadMin}m pre-final-window boundary)`;
        default:
            return `⏰ Approaching last-minute window for "${decision.nextEntry?.challengeTitle}" — ${inSeconds} (capped to the ${decision.nextEntry?.lastMinuteThreshold}m boundary)`;
    }
};

/**
 * The slice of the chain's host transport the decision needs.
 */
type DecisionDeps = Pick<
    CadenceChainDeps,
    | 'loadSettings'
    | 'fetchChallenges'
    | 'resolveLastMinuteCheckMinutes'
    | 'resolveThreshold'
    | 'resolveScheduledFill'
    | 'resolveFinalWindowTopUp'
    | 'resolveBoostPrefill'
    | 'resolveCurrencyAuto'
    | 'resolveScenarioWake'
    | 'log'
>;

/**
 * The one decision point: read fresh settings, resolve the active list, ask
 * computeNextCycleDelayMs how long to wait, and log the cadence line. Throws on
 * any failure — the caller owns the random-cadence fallback.
 *
 * `prefetched` lets a just-completed cycle hand over the active list it
 * already fetched, so we skip a redundant fetch. A non-array
 * (null/undefined, a boolean, or a cycle that failed before fetching) falls back to a fresh fetch. In normal mode the wait is
 * anchored to the *start* of the previous cycle so the gap between cycle
 * starts ≈ the rolled delay regardless of how long the cycle took; in
 * approaching/last-minute/scheduled mode the wait runs from cycle
 * completion so the boundary is never undershot.
 *
 * @param deps - the chain's host transport (see createCadenceChain)
 *   the wait plus the list/clock snapshot for the onCycleChallenges hook
 */
const decideNextWait = async (
    deps: DecisionDeps,
    prefetched: CycleResult,
    previousCycleStartMs: number | null,
): Promise<{ waitMs: number; cycleChallenges: Challenge[]; cycleNow: number }> => {
    const settings = await deps.loadSettings();
    const normalDelayMs = getRandomCheckFrequencyMs(settings);
    // When no list was handed over we fetch fresh — and keep the
    // fetchFailed flag, not just the list. An outage resolves to
    // `{ challenges: [], fetchFailed: true }`, and that empty list would
    // otherwise decide a full normal-cadence wait indistinguishable from
    // "nothing to vote on". The flag lets the normal branch shorten
    // the wait so the loop re-probes soon after connectivity returns.
    const fetched: ActiveChallengesResponse | null = Array.isArray(prefetched)
        ? { challenges: prefetched }
        : await deps.fetchChallenges(settings);
    const challenges = fetched?.challenges || [];
    const fetchFailedNow = fetched?.fetchFailed === true;
    const now = Math.floor(Date.now() / 1000);
    const lastMinuteCheckMinutes = Number(await deps.resolveLastMinuteCheckMinutes()) || 1;

    const decision = await computeNextCycleDelayMs(challenges, now, {
        resolveThreshold: deps.resolveThreshold,
        normalDelayMs,
        lastMinuteCheckMinutes,
        minGapMs: MIN_CYCLE_GAP_MS,
        resolveScheduledFill: deps.resolveScheduledFill,
        timezone: settings.timezone || DEFAULT_TIMEZONE,
        resolveFinalWindowTopUp: deps.resolveFinalWindowTopUp,
        resolveBoostPrefill: deps.resolveBoostPrefill,
        resolveCurrencyAuto: deps.resolveCurrencyAuto,
        resolveScenarioWake: deps.resolveScenarioWake,
    });

    if (decision.mode === 'normal') {
        const waitMs = normalWaitMs(decision.delayMs, previousCycleStartMs, fetchFailedNow);
        await deps.log.cadence(
            'normal',
            `Next cycle in ${(waitMs / 60_000).toFixed(2)} min (target ${(decision.delayMs / 60_000).toFixed(2)} min between starts, range ${settings.checkFrequencyMin}-${settings.checkFrequencyMax})`,
        );
        return { waitMs, cycleChallenges: challenges, cycleNow: now };
    }
    const waitMs = decision.delayMs;
    await deps.log.cadence(decision.mode, describeBoundaryCadence(decision, waitMs));
    return { waitMs, cycleChallenges: challenges, cycleNow: now };
};

/**
 * decideNextWait, degraded on failure: an error deciding the delay must never
 * kill the loop — fall back to a plain random cadence; the next cycle re-reads
 * on success. The fallback carries no challenge snapshot, so the
 * onCycleChallenges hook is skipped on EVERY decision failure — an early
 * fetch/settings throw and a late one (resolveLastMinuteCheckMinutes,
 * computeNextCycleDelayMs, the cadence log) alike.
 */
export const decideNextWaitOrFallBack = async (
    deps: DecisionDeps,
    prefetched: CycleResult,
    previousCycleStartMs: number | null,
): Promise<
    | { waitMs: number; cycleChallenges: Challenge[]; cycleNow: number }
    | { waitMs: number; cycleChallenges: null; cycleNow: null }
> => {
    try {
        return await decideNextWait(deps, prefetched, previousCycleStartMs);
    } catch (error) {
        await deps.log.decisionError(error);
        let waitMs;
        try {
            waitMs = getRandomCheckFrequencyMs(await deps.loadSettings());
        } catch {
            waitMs = getRandomCheckFrequencyMs({});
        }
        return { waitMs, cycleChallenges: null, cycleNow: null };
    }
};
