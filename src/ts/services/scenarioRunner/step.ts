/**
 * One scenario step for a challenge inside the voting pass.
 */

import * as logger from '../../logger';
import * as settings from '../../settings';
import * as runtime from '../../runtime';
import * as nativeAutovote from '../NativeAutovoteBridge';
import { DEFAULT_TIMEZONE } from '../../settings/uiDefaults';
import { evaluateScenario } from '../../scenarios/evaluate';
import { entriesOf } from '../../scenarios/selectors';
import { recordVoteSample } from '../../scenarios/speed';
import { initialState } from '../../scenarioStateStore';
import type { Challenge } from '../../types/gurushots';
import type { ScenarioState } from '../../types/stores';
import type { PassContext } from '../votingOrchestrator';
import { errorMessage } from '../../errorMessage';
import type { RunnerContext, ScenarioAction, ScenarioPass } from './types';
import { log, nowSec, usesBalance } from './support';
import { runRule, withNotice } from './rule';

/**
 * The challenge's state for `scenario`, starting it (at the start phase) when
 * it has none or was running a different scenario. Null when unreadable.
 *
 * @param now - unix seconds
 */
const loadState = (ctx: RunnerContext, now: number): ScenarioState | null => {
    const { corrupt, state } = ctx.ledger.get(ctx.challengeId);
    if (corrupt) {
        log().error(
            `${logger.challengeTag(ctx.challenge)} scenario state is unreadable — reset it (scenario-reset) to start the plan again`,
            null,
        );
        return null;
    }
    if (state && state.scenario.toLowerCase() === ctx.scenario.name.toLowerCase()) return state;
    const fresh = initialState(ctx.scenario.name, ctx.scenario.start, now);
    ctx.ledger.set(ctx.challengeId, fresh);
    log().info(
        `${logger.challengeTag(ctx.challenge)} scenario "${ctx.scenario.name}" started in phase ${fresh.phase}`,
        null,
    );
    return fresh;
};

/**
 * One pass's scenario step for a challenge. No-op when the pass has no
 * scenario deps, the host defers scenarios to another loop, or the
 * challenge has no (known) scenario.
 *
 * @param now - unix seconds
 * @param pass - the voting pass context (token, api, fillDeps, currency, scenarios)
 */
const runScenarioStep = async (challenge: Challenge, now: number, pass: PassContext) => {
    const deps = pass.scenarios;
    if (!deps || (deps.enabled && !deps.enabled())) return;
    try {
        const challengeId = String(challenge.id);
        const name = settings.getEffectiveSetting('scenario', challengeId);
        if (!name) return;
        const scenario = settings.getScenario(name);
        if (!scenario) {
            log().warning(
                `${logger.challengeTag(challenge)} has scenario "${name}", which does not exist — nothing runs`,
                null,
            );
            return;
        }
        const timezone = settings.getSetting('timezone') || DEFAULT_TIMEZONE;
        // Every host that runs scenarios passes the currency endpoints too.
        const scenarioPass = pass as ScenarioPass;
        const ctx: RunnerContext = {
            challenge,
            challengeId,
            scenario,
            timezone,
            pass: scenarioPass,
            ledger: deps.ledger,
        };
        let state = loadState(ctx, now);
        if (!state) return;
        // One vote sample per pass feeds the speed conditions (scenarios/speed.ts).
        state = { ...state, history: recordVoteSample(state.history, entriesOf(challenge), now) };
        ctx.ledger.set(challengeId, state);

        const firedThisPass: Set<string> = new Set();
        const visited = new Set([state.phase]);
        const needsBankroll = usesBalance(scenario);
        for (;;) {
            const bankroll = needsBankroll ? await scenarioPass.currency.strategy.getBankroll(pass.token) : null;
            const decision = evaluateScenario({
                scenario,
                state,
                challenge,
                now: nowSec(),
                timezone,
                bankroll,
                skipRuleIds: firedThisPass,
            });
            if (decision.halted) {
                if (state.lastError?.message !== decision.halted) {
                    // A halt needs the user, so it is also a notice (once per distinct halt).
                    const at = nowSec();
                    state = withNotice(
                        { ...state, lastError: { at, message: decision.halted } },
                        `Halted: ${decision.halted}`,
                        at,
                    );
                    ctx.ledger.set(challengeId, state);
                }
                log().error(`${logger.challengeTag(challenge)} scenario halted: ${decision.halted}`, null);
                return;
            }
            if (!decision.fire) return;
            firedThisPass.add(decision.fire.ruleId);
            const outcome = await runRule(decision.fire, ctx, state);
            state = outcome.state;
            if (!outcome.completed) return;
            if (!visited.has(state.phase)) {
                visited.add(state.phase);
            } else if (decision.fire.rule.do.some((action: ScenarioAction) => action.type === 'goto')) {
                log().warning(
                    `${logger.challengeTag(challenge)} scenario "${scenario.name}" came back to phase ${state.phase} in one pass — continuing next pass`,
                    null,
                );
                return;
            }
        }
    } catch (error) {
        log().error(`${logger.challengeTag(challenge)} scenario step failed: ${errorMessage(error) || error}`, null);
    }
};

/**
 * True in the Android app WebView when the native background service is
 * available: that service runs its own voting pass (and its own copy of the
 * scenario state) alongside the in-app loop, so it alone advances scenarios.
 */
const backgroundServiceOwnsScenarios = () =>
    runtime.isCapacitor() && !runtime.isHeadlessService() && nativeAutovote.isAvailable();

export { runScenarioStep, backgroundServiceOwnsScenarios };
