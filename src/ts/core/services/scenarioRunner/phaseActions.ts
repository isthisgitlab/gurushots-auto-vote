/**
 * The scenario actions that change what a subject runs under: `setSetting` / `clearSetting` (the runtime phase patch),
 * `useProfile` (the runtime phase profile), `pauseScenario` and `handoffScenario`.
 *
 * A patch or a profile is kept in the subject's progress record and is the top tier of its overlay for this phase entry
 * (settings/scenarioOverlay.ts); nothing here writes the configuration. Before a change is made, the settings of the record it
 * would leave are prepared (the overlay's own check: every value by its setting's validation, the pairs and groups as a
 * whole): one that does not hold refuses the action with the reason and changes nothing.
 */

import * as settings from '../../settings';
import { evaluateExpression, storedSettingValue } from '../../scenarios/expressions';
import type { ExpressionContext } from '../../scenarios/expressions';
import { INSTALLATION_KEY } from '../../scenarioStateStore';
import { simulationScope } from '../../simulationScope';
import type { ScenarioExpr } from '../../types/scenario';
import type { ScenarioState } from '../../types/stores';
import type { ScenarioValueDescriptor } from '../../types/settings';
import { expressionEvidence, loadEvidence } from './facts';
import { checkOverlay } from './overlay';
import { deferred, done, failed, nowSec, skipped } from './support';
import type {
    AccountContext,
    ActionHandler,
    ActionOutcome,
    ContextOf,
    OverlayContext,
    RunnerContext,
    ScenarioAction,
} from './types';

type PhaseActionType =
    | 'setSetting'
    | 'clearSetting'
    | 'useProfile'
    | 'pauseScenario'
    | 'handoffScenario'
    | 'startAutovote'
    | 'stopAutovote';

/** Why a handoff step fails inside a simulation (it would change the saved assignment). */
const HANDOFF_NOT_SIMULATED = 'a handoff changes the saved assignment, which a simulation does not do';

/** A setSetting value is an expression when it is an object (a literal is a flag, a number, a text or a list). */
const isExpression = (value: unknown): value is ScenarioExpr =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

/** What the expressions of this subject read settings through: the base view, and the view with the published overlay. */
const settingReader =
    (ctx: OverlayContext): NonNullable<ExpressionContext['readSetting']> =>
    (key, view) =>
        ctx.stage === 'account'
            ? view === 'base'
                ? settings.readScenarioSetting(key, 'base', null)
                : settings.readInstallationSetting(key)
            : settings.readScenarioSetting(key, view, ctx.challengeId);

/** The facts of this subject, for an expression worked out as the action runs. */
const factsOf = async (ctx: OverlayContext, state: ScenarioState, expr: ScenarioExpr): Promise<ExpressionContext> => {
    const evidence = await loadEvidence(expressionEvidence(expr), ctx);
    const base = {
        state: { phaseEnteredAt: state.phaseEnteredAt, memory: state.memory, history: state.history },
        now: nowSec(),
        timezone: ctx.timezone,
        readSetting: settingReader(ctx),
        ...evidence,
    };
    switch (ctx.stage) {
        case 'account':
            return { ...base, subject: { kind: 'installation' } };
        case 'preJoin':
            return {
                ...base,
                challenge: ctx.challenge,
                subject: { kind: 'candidate', challenge: ctx.challenge, provenance: 'open-list' },
            };
        default:
            return {
                ...base,
                challenge: ctx.challenge,
                subject: { kind: 'active', challenge: ctx.challenge, provenance: 'active-list' },
            };
    }
};

/**
 * The value a setSetting stores: the literal as written, or the expression worked out now (unknown defers the step, absent
 * or not of the setting's type skips it) and converted to the setting's stored form.
 */
const patchValue = async (
    action: Extract<ScenarioAction, { type: 'setSetting' }>,
    ctx: OverlayContext,
    state: ScenarioState,
    descriptor: ScenarioValueDescriptor,
): Promise<{ value: unknown } | { outcome: ActionOutcome }> => {
    if (!isExpression(action.value)) return { value: action.value };
    const result = evaluateExpression(action.value, await factsOf(ctx, state, action.value));
    if (result.state === 'unknown')
        return { outcome: deferred(`the value cannot be worked out yet (${result.reason})`) };
    if (result.state === 'absent') return { outcome: skipped(`the value is absent (${result.reason})`) };
    const stored = storedSettingValue(descriptor, result.value);
    return stored.ok
        ? { value: stored.value }
        : { outcome: skipped(`the value does not fit ${action.key} (${stored.reason})`) };
};

/**
 * A patch change as a step: refused, with the reason, when the record it would leave cannot have its settings prepared.
 */
const patchOutcome = async (
    ctx: OverlayContext,
    state: ScenarioState,
    patch: Record<string, unknown>,
    change: NonNullable<Extract<ActionOutcome, { status: 'done' }>['patch']>,
): Promise<ActionOutcome> => {
    const candidate: ScenarioState = { ...state, phasePatch: patch };
    if (Object.keys(patch).length === 0) delete candidate.phasePatch;
    const why = await checkOverlay(ctx, candidate);
    return why === null ? done({ patch: change }) : skipped(`the setting was not changed: ${why}`);
};

/** The scope a subject's patch is for, as a message words the scenario: an installation scenario patches installation settings, a challenge one a challenge's. */
const SCOPE_WORDS = { challenge: 'a challenge scenario', installation: 'an installation scenario' } as const;
const scopeOf = (ctx: OverlayContext) => (ctx.stage === 'account' ? 'installation' : 'challenge');

const PHASE_ACTIONS: { [K in PhaseActionType]: ActionHandler<Extract<ScenarioAction, { type: K }>, ContextOf<K>> } = {
    setSetting: async (action, ctx, state) => {
        const capability = settings.scenarioCapability(action.key);
        const scope = scopeOf(ctx);
        // The document's validation refuses a key its scope may not change; a stored document is read back without it.
        if (!capability?.phaseWrite.includes(scope)) {
            return skipped(`${action.key} is not a setting ${SCOPE_WORDS[scope]} can change`);
        }
        const resolved = await patchValue(action, ctx, state, capability.value);
        if ('outcome' in resolved) return resolved.outcome;
        return patchOutcome(
            ctx,
            state,
            { ...state.phasePatch, [action.key]: resolved.value },
            { set: action.key, value: resolved.value },
        );
    },

    clearSetting: async (action, ctx, state) => {
        const { [action.key]: removed, ...rest } = state.phasePatch ?? {};
        // Nothing patched under this key: there is nothing to undo.
        if (removed === undefined) return done();
        return patchOutcome(ctx, state, rest, { clear: action.key });
    },

    useProfile: async (action, ctx, state) => {
        let profile: string | null = null;
        if (action.name !== null) {
            const found = settings.checkPhaseProfile(action.name);
            if (!found.ok) return skipped(found.reason);
            profile = found.name;
        }
        const why = await checkOverlay(ctx, { ...state, phaseProfile: profile });
        return why === null ? done({ profile }) : skipped(`the profile was not changed: ${why}`);
    },

    // The reason is the scenario author's, shown on the status line as written (none: an empty one).
    pauseScenario: async (action) => done({ pause: action.reason ?? '' }),

    startAutovote: (_action, ctx) => requestVotingStages(ctx, true),

    stopAutovote: (_action, ctx) => requestVotingStages(ctx, false),

    handoffScenario: async (action, ctx: RunnerContext, state) => {
        const generation =
            ctx.challengeId === INSTALLATION_KEY ? settings.installationGeneration() : (state.generation ?? 0);
        if (generation === null) return deferred('the saved progress cannot be read');
        // The step that asks is the rule in progress: it is the one rule the handoff may begin under.
        const from = state.inFlight
            ? { ruleId: state.inFlight.ruleId, actionIndex: state.inFlight.actionIndex }
            : undefined;
        // A handoff changes the saved assignment, which a simulation never writes: the step fails, and the rule stays at it.
        if (simulationScope()) return failed(HANDOFF_NOT_SIMULATED);
        const result = await settings.requestScenarioHandoff(ctx.challengeId, action.to, generation, from);
        if (result.ok) return done({ handedOff: true });
        const message = `the handoff was refused (${result.reason})`;
        return result.reason === 'busy' || result.reason === 'not-saved' || result.reason === 'state-unreadable'
            ? deferred(message)
            : failed(message);
    },
};

/**
 * A request for the voting stages, through the controller the cycle was given. A refusal is typed: an obsolete request (a Stop
 * came after the cycle began, or is in effect) is retried by a later run, never forced; the others pass the step over.
 */
const requestVotingStages = async (ctx: AccountContext, on: boolean): Promise<ActionOutcome> => {
    if (!ctx.autovote) return skipped('this runtime has no autovote controller');
    const result = await ctx.autovote(on);
    if (result.ok) return done();
    switch (result.reason) {
        case 'obsolete':
            return deferred('autovote was stopped, so the request was not applied');
        case 'not-armed':
            return skipped('autovote is not armed');
        default:
            return skipped('this runtime cannot pause the voting stages');
    }
};

export { PHASE_ACTIONS };
