/**
 * The published settings overlay of a challenge subject (a candidate or a joined challenge), as the runner prepares and
 * publishes it: one evaluation of a phase's settings, the check a settings action makes before it changes anything, and the
 * publication made again after one. The installation's own counterpart is in installation.ts.
 *
 * The publication is written into the subject's progress record by whoever holds the subject's step lock (the runner), and
 * every consumer reads it through the settings facade; nothing here evaluates anything for a reader.
 */

import * as settings from '../../settings';
import { evaluateExpression, expressionNodes } from '../../scenarios/expressions';
import { evaluateSchedules } from '../autoFill/schedule';
import type { ExpressionContext } from '../../scenarios/expressions';
import type { FactEvidence } from '../../scenarios/facts';
import type { ScenarioExpr } from '../../types/scenario';
import type { ScenarioState } from '../../types/stores';
import { loadScenarioSnapshot } from './facts';
import { nowSec } from './support';
import type { ActiveContext, OverlayContext, PreJoinContext } from './types';

/** A step on a challenge the account has or can join: a candidate before the join, a joined challenge in the pass. */
type ChallengeContext = ActiveContext | PreJoinContext;

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

type PreparedSettings = ReturnType<typeof settings.prepareScenarioSnapshot>;

/**
 * The settings of `state`'s phase, prepared: the base values, and the overlay the phase gives with its bindings worked out
 * from the base settings and the raw evidence. Nothing is stored.
 */
const preparedSettings = (ctx: ChallengeContext, state: ScenarioState, raw: FactEvidence): PreparedSettings => {
    const { challenge, challengeId, scenario, timezone } = ctx;
    const observedAt = nowSec();
    const { schedules } = scenario.phases[state.phase];
    const expressions = scenario.phases[state.phase].bindings ?? {};
    return settings.prepareScenarioSnapshot(
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
            return {
                bound: Object.fromEntries(
                    Object.entries(expressions).map(([key, expr]) => [key, evaluateExpression(expr, facts)]),
                ),
                validUntil: nextBindingInstant(Object.values(expressions), facts, observedAt),
                // The schedules are worked out from the same evidence, at the same moment, as the bindings.
                ...(schedules ? { schedules: evaluateSchedules(schedules, facts) } : {}),
            };
        },
        observedAt,
    );
};

/**
 * Writes what a successful preparation published into the record (the step lock is held, and the ledger write is the one
 * that already holds the state): the state as written, or null when it was not saved.
 */
const publishPrepared = (
    ctx: ChallengeContext,
    state: ScenarioState,
    snapshot: Extract<PreparedSettings, { ok: true }>['snapshot'],
): ScenarioState | null => {
    const { publication } = snapshot;
    const next = publication ? { ...withoutPublication(state), published: publication } : withoutPublication(state);
    return next === state || ctx.ledger.set(ctx.challengeId, next) === 'saved' ? next : null;
};

/**
 * Why the settings of a record cannot be prepared (the phase's bindings do not resolve, or its profile, patch or the whole
 * does not hold), or null when they can. Nothing is written: a settings action asks it of the record it would leave.
 */
const checkChallengeOverlay = async (ctx: ChallengeContext, candidate: ScenarioState): Promise<string | null> => {
    const raw = await loadScenarioSnapshot(ctx.scenario, ctx, candidate.phase, 'raw');
    const prepared = preparedSettings(ctx, candidate, raw);
    if (prepared.ok) return null;
    return prepared.key === null ? prepared.reason : `${prepared.key}: ${prepared.reason}`;
};

/**
 * Makes the overlay again for the record as it now stands (after a patch or a profile was saved): false when it could not
 * be prepared or was not saved, in which case the next evaluation of the phase reports it.
 */
const publishChallengeOverlay = async (ctx: ChallengeContext): Promise<boolean> => {
    const { state } = ctx.ledger.get(ctx.challengeId);
    if (!state) return false;
    const prepared = preparedSettings(ctx, state, await loadScenarioSnapshot(ctx.scenario, ctx, state.phase, 'raw'));
    return prepared.ok && publishPrepared(ctx, state, prepared.snapshot) !== null;
};

/**
 * Why the settings of a record cannot be prepared for the subject a settings action runs on (the installation's own check, or
 * a challenge's), or null when they can. Nothing is written.
 */
const checkOverlay = (ctx: OverlayContext, candidate: ScenarioState): Promise<string | null> =>
    ctx.stage === 'account' ? ctx.overlay.check(candidate) : checkChallengeOverlay(ctx, candidate);

export {
    checkChallengeOverlay,
    checkOverlay,
    nextBindingInstant,
    preparedSettings,
    publishChallengeOverlay,
    publishPrepared,
    withoutPublication,
};
export type { ChallengeContext };
