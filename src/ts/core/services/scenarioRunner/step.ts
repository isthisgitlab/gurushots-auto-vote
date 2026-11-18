/**
 * One scenario step for a challenge inside the voting pass.
 *
 * Contract: see the runner contract in the scenarioRunner.ts header (live re-read
 * before each action, persist after each, unreadable state halts).
 */

import * as logger from '../../logger';
import * as settings from '../../settings';
import { platform } from '../../platform/port';
import { effectiveTimezone } from '../../settings/uiDefaults';
import { evaluateScenario } from '../../scenarios/evaluate';
import { evaluateExpression } from '../../scenarios/expressions';
import { entriesOf } from '../../scenarios/selectors';
import { recordVoteSample } from '../../scenarios/speed';
import { initialState } from '../../scenarioStateStore';
import type { StateLock } from '../../scenarioStateStore';
import type { Challenge } from '../../types/gurushots';
import type { ScenarioExpr } from '../../types/scenario';
import type { ScenarioState } from '../../types/stores';
import type { ExpressionContext } from '../../scenarios/expressions';
import type { FactEvidence, FactSubject } from '../../scenarios/facts';
import { createOperationRecord } from '../../scenarios/runtime';
import type { PassContext } from '../votingOrchestrator';
import { errorMessage } from '../../errorMessage';
import type { ActiveContext, PreJoinContext, RunnerContext, ScenarioAction, ScenarioPass } from './types';
import { log, nowSec } from './support';
import { loadScenarioSnapshot, passReads } from './facts';
import { runRule, withNotice } from './rule';

const NO_LOCK: StateLock = { ok: true, release: () => {} };

const corruptText = (kind: 'file' | 'record' | 'unloaded', challengeId: string) =>
    kind === 'unloaded'
        ? 'scenario state is not loaded yet (the saved progress could not be read in) — nothing runs until it is'
        : kind === 'file'
          ? 'scenario state is unreadable — reset the progress of every challenge (scenario-reset --all, or the Reset button on a challenge card) to start the plans again'
          : `scenario state of this challenge is unreadable — reset it (scenario-reset --challenge=${challengeId}, or the Reset button on its card) to start the plan again`;

/** A step on a challenge the account has or can join: a candidate before the join, a joined challenge in the pass. */
type ChallengeContext = ActiveContext | PreJoinContext;

/**
 * The subject the facts of a step are read on, with where it came from.
 */
const subjectOf = (ctx: RunnerContext): FactSubject => {
    switch (ctx.stage) {
        case 'active':
            return { kind: 'active', challenge: ctx.challenge, provenance: 'active-list' };
        case 'preJoin':
            return { kind: 'candidate', challenge: ctx.challenge, provenance: 'open-list' };
        case 'postClose':
            return { kind: 'completed', challenge: ctx.completed, provenance: 'completed-list' };
        default:
            return { kind: 'installation' };
    }
};

/**
 * A challenge with a handoff intent: finishes the handoff when the assignment is one the intent names, otherwise says
 * so. The step runs nothing this pass either way (a finished handoff starts the new scenario on the next one).
 */
const heldByHandoff = (ctx: RunnerContext, state: ScenarioState): null => {
    const settled = settings.settleHandoff(ctx.challengeId, state);
    const tag = ctx.tag;
    if (settled === 'conflict') {
        noteHalt(ctx, state, 'handoff-conflict');
        log().error(`${tag} scenario handoff conflicts with the assignment — nothing runs`, null);
    } else if (settled === 'failed') {
        log().warning(`${tag} scenario handoff could not be finished — nothing runs until it can`, null);
    } else {
        log().info(`${tag} scenario handoff finished — the new scenario starts next pass`, null);
    }
    return null;
};

/**
 * The challenge's state for `scenario`, starting it (at the start phase) when
 * it has none or was running a different scenario. Null when unreadable.
 *
 * @param now - unix seconds
 */
const loadState = (ctx: RunnerContext, now: number): ScenarioState | null => {
    const { corrupt, state, epoch } = ctx.ledger.get(ctx.challengeId);
    if (corrupt) {
        log().error(`${ctx.tag} ${corruptText(corrupt, ctx.challengeId)}`, null);
        return null;
    }
    // A handoff begun and not finished holds the challenge: it is finished (or reported) first, and nothing runs meanwhile.
    if (state?.handoff) return heldByHandoff(ctx, state);
    // A paused challenge runs no action and publishes nothing: its progress and its publication stay as they are.
    if (state?.paused) {
        log().debug(`${ctx.tag} scenario is paused — nothing runs`, null);
        return null;
    }
    if (state && state.scenario.toLowerCase() === ctx.scenario.name.toLowerCase()) return state;
    // A different scenario is assigned over a step that may have spent something: no fresh progress is made over it.
    if (state && settings.unresolvedScenarioWork(state)) {
        noteHalt(ctx, state, 'scenario-changed-with-unresolved-work');
        return null;
    }
    // Stamped with the resets and the generation it starts under, like any state read: neither a reset in between nor a
    // handoff is undone by it.
    const fresh = {
        ...initialState(ctx.scenario.name, ctx.scenario.start, now),
        ...(state?.generation === undefined ? {} : { generation: state.generation }),
        epoch,
    };
    if (ctx.ledger.set(ctx.challengeId, fresh) !== 'saved') return null;
    log().info(`${ctx.tag} scenario "${ctx.scenario.name}" started in phase ${fresh.phase}`, null);
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
 * The state without its published overlay (and the flag that a stored one was malformed): the same object when there is
 * nothing to drop.
 */
const withoutPublication = (state: ScenarioState): ScenarioState => {
    if (!state.published && !state.publicationUnreadable) return state;
    const rest = { ...state };
    delete rest.published;
    delete rest.publicationUnreadable;
    return rest;
};

/**
 * The expressions of a phase's bindings and the sub-expressions of each, depth first.
 */
const expressionNodes = (expr: ScenarioExpr): ScenarioExpr[] => {
    switch (expr.kind) {
        case 'offset':
            return [expr, ...expressionNodes(expr.from), ...expressionNodes(expr.by)];
        case 'difference':
            return [expr, ...expressionNodes(expr.from), ...expressionNodes(expr.to)];
        case 'add':
        case 'subtract':
            return [expr, ...expressionNodes(expr.left), ...expressionNodes(expr.right)];
        case 'earlier':
        case 'later':
        case 'min':
        case 'max':
            return [expr, ...expr.of.flatMap(expressionNodes)];
        default:
            return [expr];
    }
};

/**
 * The next clock boundary that can change what the bindings resolve to: the earliest instant in the future that any part of
 * them stands for (a close time, a point offset from it). Null when there is none. A published overlay is valid until
 * then, and is made again after it.
 *
 * @param now - unix seconds
 */
const nextBindingInstant = (bindings: readonly ScenarioExpr[], ctx: ExpressionContext, now: number): number | null => {
    const instants = bindings
        .flatMap(expressionNodes)
        .map((node) => evaluateExpression(node, ctx))
        .flatMap((value) =>
            value.state === 'known' && value.value.kind === 'number' && value.value.quantity === 'instant'
                ? [value.value.value]
                : [],
        )
        .filter((instant) => instant > now);
    return instants.length ? Math.min(...instants) : null;
};

/**
 * The words of a phase whose settings could not be prepared, for the halt notice: the phase, the setting that failed
 * (none when it is the profile), and why.
 */
const blockedText = (phase: string, key: string | null, reason: string): string =>
    key === null ? `phase ${phase}: ${reason}` : `phase ${phase}: ${key}: ${reason}`;

/**
 * Stops a challenge whose phase settings could not be prepared: its stale publication is cleared (so every reader finds
 * the settings unavailable rather than the previous values), and the halt is recorded as a notice. No rule runs.
 */
const blockPhase = (
    ctx: ChallengeContext,
    state: ScenarioState,
    failure: { key: string | null; reason: string },
): void => {
    const cleared = withoutPublication(state);
    if (cleared !== state && ctx.ledger.set(ctx.challengeId, cleared) !== 'saved') return;
    const halted = blockedText(state.phase, failure.key, failure.reason);
    noteHalt(ctx, cleared, halted);
    log().error(`${ctx.tag} scenario halted: ${halted}`, null);
};

/**
 * What one evaluation of a phase reads: its evidence, and its settings. A phase with bindings or a profile gets its overlay
 * prepared and published here (the step lock is held, and the ledger write is the one that already holds the state), and
 * the evidence that derives from the effective settings is loaded only once that overlay stands. Null when the phase's
 * settings could not be prepared (the challenge is stopped) or the publication was not saved: no rule may run.
 */
const prepareEvaluation = async (
    ctx: ChallengeContext,
    state: ScenarioState,
): Promise<{ state: ScenarioState; evidence: FactEvidence; readSetting?: ExpressionContext['readSetting'] } | null> => {
    const { challenge, challengeId, scenario, timezone } = ctx;
    const raw = await loadScenarioSnapshot(scenario, ctx, state.phase, 'raw');
    const phase = scenario.phases[state.phase];
    // A phase the scenario no longer has is the engine's to halt.
    if (!phase) return { state, evidence: raw };
    const observedAt = nowSec();
    const prepared = settings.prepareScenarioSnapshot(
        challengeId,
        scenario,
        state,
        (readBase) => {
            const facts: ExpressionContext = {
                challenge,
                state,
                now: observedAt,
                timezone,
                ...raw,
                readSetting: readBase,
            };
            const expressions = phase.bindings ?? {};
            return {
                bound: Object.fromEntries(
                    Object.entries(expressions).map(([key, expr]) => [key, evaluateExpression(expr, facts)]),
                ),
                validUntil: nextBindingInstant(Object.values(expressions), facts, observedAt),
            };
        },
        observedAt,
    );
    if (!prepared.ok) {
        blockPhase(ctx, state, prepared);
        return null;
    }
    const { publication, readSetting } = prepared.snapshot;
    const next = publication ? { ...withoutPublication(state), published: publication } : withoutPublication(state);
    if (next !== state && ctx.ledger.set(challengeId, next) !== 'saved') return null;
    const policy = await loadScenarioSnapshot(scenario, ctx, state.phase, 'policy');
    return { state: next, evidence: { ...raw, ...policy }, readSetting };
};

/**
 * What one evaluation of a step reads: its overlay prepared and published for a challenge (a candidate's included), the
 * evidence alone for the other subjects. Null when no rule may run.
 */
const prepare = (
    ctx: RunnerContext,
    state: ScenarioState,
): Promise<{ state: ScenarioState; evidence: FactEvidence; readSetting?: ExpressionContext['readSetting'] } | null> =>
    ctx.stage === 'active' || ctx.stage === 'preJoin'
        ? prepareEvaluation(ctx, state)
        : loadScenarioSnapshot(ctx.scenario, ctx, state.phase, 'all').then((evidence) => ({ state, evidence }));

/**
 * Runs the rules of the subject's scenario that run in this step's stage and are due, one after another, until none is or
 * one stops.
 *
 * @param now - unix seconds
 */
const advance = async (ctx: RunnerContext, now: number): Promise<void> => {
    const { challengeId, scenario, timezone } = ctx;
    let state = loadState(ctx, now);
    if (!state) return;
    // One vote sample per pass feeds the speed conditions (scenarios/speed.ts); only a joined challenge has votes.
    if (ctx.stage === 'active') {
        state = { ...state, history: recordVoteSample(state.history, entriesOf(ctx.challenge), now) };
        if (ctx.ledger.set(challengeId, state) !== 'saved') return;
    }

    const subject = subjectOf(ctx);
    const challenge = subject.kind === 'active' || subject.kind === 'candidate' ? subject.challenge : undefined;
    const firedThisPass: Set<string> = new Set();
    const visited = new Set([state.phase]);
    for (;;) {
        // The settings of this phase and the evidence its rules read, fetched fresh for each evaluation (the bankroll as
        // before). A phase with bindings or a profile is published here, again after every confirmed action and phase change.
        const prepared = await prepare(ctx, state);
        if (!prepared) return;
        ({ state } = prepared);
        const decision = evaluateScenario({
            scenario,
            state,
            challenge,
            subject,
            stage: ctx.stage,
            now: nowSec(),
            timezone,
            evidence: prepared.evidence,
            readSetting: prepared.readSetting,
            skipRuleIds: firedThisPass,
        });
        if (decision.halted) {
            noteHalt(ctx, state, decision.halted);
            log().error(`${ctx.tag} scenario halted: ${decision.halted}`, null);
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
                `${ctx.tag} scenario "${scenario.name}" came back to phase ${state.phase} in one pass — continuing next pass`,
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
        const timezone = effectiveTimezone(settings.getSetting('timezone'));
        // The GUI and the CLI can run a pass at once: one rule step of a challenge runs at a time, or both would spend.
        const lock: StateLock = deps.lock ? deps.lock(challengeId) : NO_LOCK;
        if (!lock.ok) {
            noteSkipped(challenge, lock.unavailable === true);
            return;
        }
        // Every host that runs scenarios passes the currency endpoints too.
        const scenarioPass = pass as ScenarioPass;
        const tag = logger.challengeTag(challenge);
        const ctx: ActiveContext = {
            stage: 'active',
            challenge,
            challengeId,
            scenario,
            timezone,
            pass: scenarioPass,
            ledger: deps.ledger,
            stepLock: lock,
            beforeSpend: null,
            tag,
            reads: passReads(scenarioPass, tag),
            operations: pass.operations ?? createOperationRecord(),
        };
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
 * scenario state) alongside the in-app loop, so it alone advances scenarios —
 * and runs the automatic joins and the automatic fills, whose claims and counts
 * the app window would otherwise overwrite with its own copy. The answer is
 * the platform's (the webview family computes it from its injected native
 * part); the named export stays for the shell-side callers.
 */
const backgroundServiceOwnsScenarios = () => platform().capabilities.backgroundServiceOwnsScenarios();

export {
    runScenarioStep,
    backgroundServiceOwnsScenarios,
    nextBindingInstant,
    advance,
    loadState,
    noteSkipped,
    NO_LOCK,
};
