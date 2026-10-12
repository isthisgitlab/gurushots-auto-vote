/**
 * One scenario step for a challenge inside the voting pass.
 *
 * Contract: see the runner contract in the scenarioRunner.ts header (live re-read
 * before each action, persist after each, unreadable state halts).
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

const NO_LOCK: { ok: boolean; release: () => void; unavailable?: true } = { ok: true, release: () => {} };

const corruptText = (kind: 'file' | 'record', challengeId: string) =>
    kind === 'file'
        ? 'scenario state is unreadable — reset the progress of every challenge (scenario-reset --all, or the Reset button on a challenge card) to start the plans again'
        : `scenario state of this challenge is unreadable — reset it (scenario-reset --challenge=${challengeId}, or the Reset button on its card) to start the plan again`;

/**
 * The challenge's state for `scenario`, starting it (at the start phase) when
 * it has none or was running a different scenario. Null when unreadable.
 *
 * @param now - unix seconds
 */
const loadState = (ctx: RunnerContext, now: number): ScenarioState | null => {
    const { corrupt, state, epoch } = ctx.ledger.get(ctx.challengeId);
    if (corrupt) {
        log().error(`${logger.challengeTag(ctx.challenge)} ${corruptText(corrupt, ctx.challengeId)}`, null);
        return null;
    }
    if (state && state.scenario.toLowerCase() === ctx.scenario.name.toLowerCase()) return state;
    // Stamped with the resets it starts under, like any state read: a reset in between is not undone by it.
    const fresh = { ...initialState(ctx.scenario.name, ctx.scenario.start, now), epoch };
    if (!ctx.ledger.set(ctx.challengeId, fresh)) return null;
    log().info(
        `${logger.challengeTag(ctx.challenge)} scenario "${ctx.scenario.name}" started in phase ${fresh.phase}`,
        null,
    );
    return fresh;
};

/**
 * Records a halt on the state: it needs the user, so it is also a notice (once per distinct halt).
 */
const noteHalt = (ctx: RunnerContext, state: ScenarioState, halted: string): void => {
    if (state.lastError?.message === halted) return;
    const at = nowSec();
    ctx.ledger.set(
        ctx.challengeId,
        withNotice({ ...state, lastError: { at, message: halted } }, `Halted: ${halted}`, at),
    );
};

/**
 * Runs the rules of the challenge's scenario that are due, one after another, until none is or one stops.
 *
 * @param now - unix seconds
 */
const advance = async (ctx: RunnerContext, now: number): Promise<void> => {
    const { challenge, challengeId, scenario, timezone } = ctx;
    let state = loadState(ctx, now);
    if (!state) return;
    // One vote sample per pass feeds the speed conditions (scenarios/speed.ts).
    state = { ...state, history: recordVoteSample(state.history, entriesOf(challenge), now) };
    if (!ctx.ledger.set(challengeId, state)) return;

    const firedThisPass: Set<string> = new Set();
    const visited = new Set([state.phase]);
    const needsBankroll = usesBalance(scenario);
    for (;;) {
        const bankroll = needsBankroll ? await ctx.pass.currency.strategy.getBankroll(ctx.pass.token) : null;
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
            noteHalt(ctx, state, decision.halted);
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
};

// How many passes in a row each challenge's step was skipped because its lock was held: one is ordinary, several are
// something holding it that should not.
const skippedPasses = new Map<string, number>();
const WARN_AFTER_SKIPS = 3;

/**
 * Says why a challenge's step was skipped: a lock held by another process is ordinary (debug) until it persists, a
 * lock the app cannot make at all never is (warning: nothing runs, and the user can fix it).
 */
const noteSkipped = (challenge: Challenge, unavailable: boolean) => {
    const tag = logger.challengeTag(challenge);
    if (unavailable) {
        log().warning(
            `${tag} the app cannot create its lock files in its data folder — scenario steps are paused until it can (check the folder's permissions and the free disk space)`,
            null,
        );
        return;
    }
    const id = String(challenge.id);
    const skipped = (skippedPasses.get(id) ?? 0) + 1;
    skippedPasses.set(id, skipped);
    const said = `${tag} another process is running its scenario — skipped this pass`;
    if (skipped >= WARN_AFTER_SKIPS) log().warning(`${said} (${skipped} passes in a row)`, null);
    else log().debug(said, null);
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
        // The GUI and the CLI can run a pass at once: one rule step of a challenge runs at a time, or both would spend.
        const lock = deps.lock ? deps.lock(challengeId) : NO_LOCK;
        if (!lock.ok) {
            noteSkipped(challenge, lock.unavailable === true);
            return;
        }
        skippedPasses.delete(challengeId);
        try {
            await advance(ctx, now);
        } finally {
            lock.release();
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
