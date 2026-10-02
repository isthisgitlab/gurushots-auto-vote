/** Wake times for currency-automation rules, scenarios and boost holds. Must stay free of settings I/O: the WebView bundle imports it. */

import { ruleOpensAt } from '../../voting/currencyAuto';
import { nextWakeAt } from '../../scenarios/nextWake';
import { startState } from '../../scenarios/evaluate';
import { resolveConfigsFailSoft, challengeLabel, isSoonerUpcomingStart } from './shared';

import type { Challenge } from '../../types/gurushots';
import type { RuleTiming } from '../../voting/currencyAuto';
import type { ScenarioEngineState } from '../../types/scenario';
import type { ScenarioDocument } from '../../settings/scenarioSchema';
import type { CurrencyRuleStart, ScenarioWakeStart, BoostHoldEnd } from './shared';

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
        });
        if (startTime !== null && isSoonerUpcomingStart(startTime, now, best)) {
            best = { challengeId: open[i].id, challengeTitle: challengeLabel(open[i]), startTime, phase: state.phase };
        }
    }
    return best;
}

/**
 * Soonest instant after `now` at which a boost the voting pass held for a fresh
 * photo becomes due (`boostHoldUntil`, set by the pass on the list it returns),
 * across every still-open challenge. Needs no resolver: the hold is live pass
 * state, not a setting. A list fetched fresh by the scheduler carries no holds,
 * so the held boost then goes on the next ordinary cycle.
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
