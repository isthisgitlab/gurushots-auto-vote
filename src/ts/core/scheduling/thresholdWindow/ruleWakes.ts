/** Wake times for currency-automation rules, scenarios and boost holds. Must stay free of settings I/O: the WebView bundle imports it. */

import { ruleOpensAt } from '../../voting/currencyAuto';
import { nextWakeAt } from '../../scenarios/nextWake';
import { startState } from '../../scenarios/evaluate';
import { resolveConfigsFailSoft, challengeLabel, isSoonerUpcomingStart } from './shared';

import type { Challenge } from '../../types/gurushots';
import type { RuleTiming } from '../../voting/currencyAuto';
import type { ExpressionContext } from '../../scenarios/expressions';
import type { FactEvidence } from '../../scenarios/facts';
import type { ScenarioEngineState } from '../../types/scenario';
import type { ScenarioDocument } from '../../settings/scenarioSchema';
import type { AccountWakeStart, CurrencyRuleStart, ScenarioWakeStart, BoostHoldEnd } from './shared';

/** Per-challenge timing of each ENABLED currency-automation rule (null = rule off). */
export type ResolveCurrencyAuto = (
    challengeId: string,
) =>
    | { key: RuleTiming | null; swap: RuleTiming | null; fill: RuleTiming | null }
    | Promise<{ key: RuleTiming | null; swap: RuleTiming | null; fill: RuleTiming | null }>;

// Whether the challenge could still take the action at all — waking for a rule
// whose action the challenge doesn't offer (or has already used) would no-op.
// Live state beyond this (balance, exposure, swap caps) is left to the runner.
const CURRENCY_ACTION_OFFERED: Record<CurrencyRuleStart['action'], (c: Challenge) => boolean> = {
    key: (c) => c?.boost_enable === true && c?.member?.boost?.state === 'LOCKED',
    swap: (c) => c?.swap_enable === true && c?.swap_locked !== true,
    fill: (c) => c?.fill_enable === true && c?.fill_locked !== true,
};

/**
 * Soonest upcoming currency-automation rule opening (automatic key / swap /
 * fill, voting/currencyAuto.ts ruleOpensAt) strictly after `now`, across every
 * still-open challenge — flash included, since a flash challenge running out of
 * vote photos is exactly where the exposure-fill rule matters. The scheduler
 * caps its sleep to it so an "11h after start" or "7h before end" rule fires on
 * time instead of up to one normal cadence late. Fail-soft: a challenge whose
 * resolver throws is skipped.
 *
 * @param now - Unix timestamp (seconds)
 */
export async function soonestCurrencyRuleStart(
    challenges: Challenge[],
    now: number,
    resolveCurrencyAuto: ResolveCurrencyAuto,
): Promise<CurrencyRuleStart | null> {
    const open = (Array.isArray(challenges) ? challenges : []).filter((c) => Number(c?.close_time) > now);
    const configs = await resolveConfigsFailSoft(open, resolveCurrencyAuto);

    let best: CurrencyRuleStart | null = null;
    for (let i = 0; i < open.length; i++) {
        const challenge = open[i];
        for (const action of ['key', 'swap', 'fill'] as const) {
            const timing = configs[i]?.[action];
            if (!timing || !CURRENCY_ACTION_OFFERED[action](challenge)) continue;
            const startTime = ruleOpensAt(challenge, timing);
            if (startTime === null || startTime <= now || startTime >= Number(challenge.close_time)) continue;
            if (best === null || startTime < best.startTime) {
                best = {
                    challengeId: challenge.id,
                    challengeTitle: challengeLabel(challenge),
                    startTime,
                    action,
                };
            }
        }
    }
    return best;
}

type ScenarioWakeInput = { scenario: ScenarioDocument; state: ScenarioEngineState | null; timezone: string };

/**
 * The challenge's assigned scenario and its runtime state (null state = the
 * plan has not started yet), or null when no scenario can run for it.
 */
export type ResolveScenarioWake = (challengeId: string) => ScenarioWakeInput | null | Promise<ScenarioWakeInput | null>;

/**
 * Soonest instant after `now` at which a user-defined scenario's time
 * condition can flip (scenarios/nextWake.ts), across every still-open
 * challenge — flash included, a scenario may be assigned to any challenge.
 * A challenge whose plan has not started yet is judged from its start phase.
 * Fail-soft: a challenge whose resolver throws is skipped.
 *
 * @param now - Unix timestamp (seconds)
 */
export async function soonestScenarioWake(
    challenges: Challenge[],
    now: number,
    resolveScenarioWake: ResolveScenarioWake,
): Promise<ScenarioWakeStart | null> {
    const open = (Array.isArray(challenges) ? challenges : []).filter((c) => Number(c?.close_time) > now);
    const inputs = await resolveConfigsFailSoft(open, resolveScenarioWake);

    let best: ScenarioWakeStart | null = null;
    for (let i = 0; i < open.length; i++) {
        const input = inputs[i];
        if (!input) continue;
        const state = input.state ?? startState(input.scenario, now);
        const startTime = nextWakeAt({
            scenario: input.scenario,
            state,
            challenge: open[i],
            now,
            timezone: input.timezone,
            // No saved state = the plan has not started: it has no phase clock yet.
            phaseClock: input.state !== null,
            // What the scheduler knows of the challenge itself (its Boost, Turbo and clock); the rest is unknown and supplies no instant.
            facts: challengeFacts(open[i], state, now, input.timezone),
        });
        if (startTime !== null && isSoonerUpcomingStart(startTime, now, best)) {
            best = { challengeId: open[i].id, challengeTitle: challengeLabel(open[i]), startTime, phase: state.phase };
        }
    }
    return best;
}

/** The facts of a challenge the scheduler can read from the challenge alone: no account evidence, so those facts are unknown. */
const challengeFacts = (
    challenge: Challenge,
    state: ScenarioEngineState,
    now: number,
    timezone: string,
): ExpressionContext => ({
    challenge,
    state: { phaseEnteredAt: state.phaseEnteredAt, memory: state.memory },
    now,
    timezone,
});

/**
 * What the account's own boundaries are worked out from, read by the host once per decision. Every field is optional evidence:
 * one that is absent supplies no boundary.
 */
export type AccountWakeSources = {
    /** The installation scenario this runtime owns, its progress (null: not started), and how far ahead to look (unix seconds). */
    installation: {
        scenario: ScenarioDocument;
        state: ScenarioEngineState | null;
        timezone: string;
        horizon: number;
        evidence?: FactEvidence;
    } | null;
    /** Open and upcoming challenges the account has not joined, whose scenario has pre-join rules, with that scenario. */
    candidates: Array<{ challenge: Challenge; scenario: ScenarioDocument; timezone: string }>;
    /** The next instant the claim pass may run (unix seconds), when claiming is on. */
    claimAt: number | null;
    /** The earliest instant an unfinished mission expires (unix seconds), when the last mission read showed one. */
    missionExpiry: number | null;
};

/** The account's boundaries, or null when this host reads none. */
export type ResolveAccountWake = () => AccountWakeSources | null | Promise<AccountWakeSources | null>;

/**
 * Soonest instant after `now` of a boundary that belongs to the account and not to an active challenge: the installation
 * scenario's rule conditions and publication, a candidate's opening or pre-join rule, the claim throttle, a mission's expiry.
 * None of them is bounded by a challenge's close time: the installation looks ahead to its own explicit horizon. Unknown
 * evidence supplies no deadline. Fail-soft: a resolver that throws supplies nothing.
 *
 * @param now - Unix timestamp (seconds)
 */
export async function soonestAccountWake(
    now: number,
    resolveAccountWake: ResolveAccountWake,
): Promise<AccountWakeStart | null> {
    let sources: AccountWakeSources | null;
    try {
        sources = await resolveAccountWake();
    } catch {
        return null;
    }
    if (!sources) return null;
    let best: AccountWakeStart | null = null;
    const offer = (kind: AccountWakeStart['kind'], startTime: number | null, label: string) => {
        if (startTime !== null && Number.isFinite(startTime) && isSoonerUpcomingStart(startTime, now, best)) {
            best = { kind, startTime, label };
        }
    };
    const { installation } = sources;
    if (installation) {
        const state = installation.state ?? startState(installation.scenario, now);
        offer(
            'installation',
            nextWakeAt({
                scenario: installation.scenario,
                state,
                challenge: null,
                now,
                timezone: installation.timezone,
                phaseClock: installation.state !== null,
                facts: {
                    subject: { kind: 'installation' },
                    state: { phaseEnteredAt: state.phaseEnteredAt, memory: state.memory },
                    now,
                    timezone: installation.timezone,
                    ...installation.evidence,
                },
                horizon: installation.horizon,
            }),
            'the installation scenario',
        );
    }
    for (const { challenge, scenario, timezone } of sources.candidates) {
        const state = startState(scenario, now);
        // The candidate opens (it can be joined from then), and its pre-join rules' own conditions can flip before and after.
        offer('pre-join', Number(challenge.start_time), challengeLabel(challenge));
        offer(
            'pre-join',
            nextWakeAt({
                scenario,
                state,
                challenge,
                now,
                timezone,
                phaseClock: false,
                facts: challengeFacts(challenge, state, now, timezone),
            }),
            challengeLabel(challenge),
        );
    }
    offer('claim', sources.claimAt, 'the prize claim');
    offer('mission', sources.missionExpiry, 'a mission expiry');
    return best;
}

/**
 * Soonest instant after `now` at which a boost the voting pass held becomes due
 * (`boostHoldUntil`, set by the pass on the list it returns), across every
 * still-open challenge. The field carries three holds: a fresh photo too newly
 * submitted to boost, a Turbo pin about to give way, and a Boost pin waiting for
 * its photo to be submitted by the scheduled fill. Needs no resolver: the hold
 * is live pass state, not a setting. A list fetched fresh by the scheduler
 * carries no holds, so the held boost then goes on the next ordinary cycle.
 *
 * @param now - Unix timestamp (seconds)
 */
export function soonestBoostHoldEnd(challenges: Challenge[], now: number): BoostHoldEnd | null {
    let best: BoostHoldEnd | null = null;
    for (const challenge of Array.isArray(challenges) ? challenges : []) {
        const startTime = Number(challenge?.boostHoldUntil);
        if (!Number.isFinite(startTime) || Number(challenge.close_time) <= now) continue;
        if (isSoonerUpcomingStart(startTime, now, best)) {
            best = { challengeId: challenge.id, challengeTitle: challengeLabel(challenge), startTime };
        }
    }
    return best;
}
