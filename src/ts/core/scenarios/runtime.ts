/**
 * What a scenario step's outcome does to the subject's progress: the one reducer the live runner applies after each step
 * (services/scenarioRunner/rule.ts), written without I/O so a simulation can apply the same effects to a copy.
 *
 * Only what an outcome established is applied. A confirmed action sets its effects (memory, a counter, a notice) and moves
 * the rule on; a step that did not go through leaves the markers a spend left (`pending`, `unclear`) exactly as the runner
 * contract in services/scenarioRunner.ts describes; a finished rule is recorded as fired, with the phase change that was
 * waiting for it. The clock, the notice token and the timezone come in as arguments: nothing here reads them.
 *
 * It also holds the per-pass operation record: which operations a scenario action or the normal automation already did for
 * which subject in one pass, so the other does not repeat it.
 */

import type { ScenarioState, SpendAction } from '../types/stores';
import { firedRecord } from './evaluate';

type SpendKind = 'swaps' | 'keys' | 'fills';

/**
 * What an action did: its effects on the scenario state when done, or why not.
 */
type ActionEffects = {
    remember?: Record<string, string>;
    forget?: string;
    spent?: SpendKind;
    /** Coins a join spent or may have spent (a charge counted against the scenario's coin limit). */
    coins?: number;
    goto?: string;
    notice?: string;
    /** A change of the runtime phase patch: one setting set (its stored value), or one cleared. */
    patch?: { set: string; value: unknown } | { clear: string };
    /** The runtime phase profile from now on: a saved profile's name, or null for none. */
    profile?: string | null;
    /** The subject is paused (`reason`, for the status line); the rule stops after this step and keeps its progress. */
    pause?: string;
    /** The subject was handed to another scenario: its record is that scenario's now, and nothing more is written to it. */
    handedOff?: true;
    /** The step completed without doing the operation: why the normal policy says not now. It marks no operation as done. */
    notDue?: string;
};

type DoneOutcome = { status: 'done' } & ActionEffects;

// `unclear`: the spend of the step got no answer, so it may have gone through and is never spent again; `spent` is
// what the run counts against its limit for it (conservatively); `halt` ends the rule instead of resuming at the step.
type NotDoneOutcome = {
    status: 'skipped' | 'failed' | 'deferred';
    message: string;
    spent?: SpendKind;
    /** Coins a join spent or may have spent before it stopped: counted against the coin limit, and the step is resumed. */
    coins?: number;
    /** The step stays the one the rule resumes at, whatever else is known (a join that is paid for, not entered). */
    resume?: true;
    unclear?: SpendAction;
    halt?: true;
    /** `pending`: the rule is stopped from a marker written before the spend, not from a spend that got no answer. */
    origin?: 'pending';
};

type ActionOutcome = DoneOutcome | NotDoneOutcome;

/** Notices kept for the host notifiers: the newest, within a day. */
const OUTBOX_LIMIT = 20;
const OUTBOX_KEEP_SEC = 24 * 3600;

/**
 * State with a notice appended to its outbox (services/scenarioNotifications.ts delivers it).
 *
 * @param at - unix seconds
 * @param token - what makes the notice's id unique among those of the same second
 */
const withNotice = (state: ScenarioState, message: string, at: number, token: string): ScenarioState => {
    const kept = (state.outbox ?? []).filter((item) => at - item.at <= OUTBOX_KEEP_SEC);
    const id = `${at}-${kept.length}-${token}`;
    return { ...state, outbox: [...kept, { id, at, message }].slice(-OUTBOX_LIMIT) };
};

/**
 * State after one action's effects.
 *
 * @param at - unix seconds
 */
const applyEffects = (before: ScenarioState, effects: ActionEffects, at: number, token: string): ScenarioState => {
    const state = effects.notice ? withNotice(before, effects.notice, at, token) : before;
    const memory = { ...state.memory, ...effects.remember };
    if (effects.forget) delete memory[effects.forget];
    const counted = effects.spent
        ? { ...state.spent, [effects.spent]: (state.spent[effects.spent] ?? 0) + 1 }
        : state.spent;
    const spent = effects.coins ? { ...counted, coins: (counted.coins ?? 0) + effects.coins } : counted;
    const next: ScenarioState = { ...state, memory, spent };
    if (effects.patch) {
        const patched = { ...state.phasePatch };
        if ('set' in effects.patch) patched[effects.patch.set] = effects.patch.value;
        else delete patched[effects.patch.clear];
        if (Object.keys(patched).length > 0) next.phasePatch = patched;
        else delete next.phasePatch;
    }
    if (effects.profile !== undefined) next.phaseProfile = effects.profile;
    if (effects.pause !== undefined) next.paused = { at, reason: effects.pause };
    return next;
};

/** The step an outcome is for: where in which rule, when, and under what the rule's state was. */
type ReducerStep = {
    ruleId: string;
    index: number;
    actionType: string;
    /** unix seconds */
    at: number;
    timezone: string;
    /** A rule that went through a step before, or whose spend got no answer: a skipped step is passed over. */
    committed: boolean;
    /** Makes the id of a notice this step leaves unique. */
    noticeToken: string;
    /** How a problem of this step is recorded as the last one: the rule and the action, then why. */
    message: string;
};

/**
 * State when a step stops its rule. The rule resumes at that step when it was committed.
 *
 * A spend that got no answer may have gone through: it commits the rule from here, so the retry resumes at this step
 * (marked on `inFlight` itself, which survives anything that only changes `lastError`) and never spends it again,
 * and it counts toward the scenario's spend limit. The markers of the step's other spends (an edit of the scenario
 * can leave several) stay with it, so reverting the edit never spends one of them. When the retry cannot show the
 * spend landed (`halt`) the rule ends here and is recorded as fired with the action it stopped after, so its repeat
 * policy holds it (evaluate).
 */
const stoppedAt = (state: ScenarioState, step: ReducerStep, result: NotDoneOutcome): ScenarioState => {
    const { ruleId, index, at, committed, timezone, noticeToken, message } = step;
    const next: ScenarioState = { ...state, inFlight: null };
    if (result.halt) {
        next.fired = {
            ...state.fired,
            [ruleId]: {
                ...firedRecord(state, at, timezone),
                unclearHalt: result.unclear,
                haltOrigin: result.origin,
            },
        };
    } else if (committed || result.spent || result.coins || result.resume) {
        // (The state's own marker is this step's: the one before a spend, or the one the step before it left. Its
        // `pending` is this step's own spend, which was made or refused: it is not carried.)
        const prior = state.inFlight;
        // A type the marker already holds is not appended again: a settle whose re-read cannot be trusted repeats
        // the same outcome pass after pass.
        const unclear = [...(prior?.unclear ?? [])];
        const repeat = result.unclear !== undefined && unclear.includes(result.unclear);
        if (result.unclear && !repeat) unclear.push(result.unclear);
        // A `pending`-origin retry keeps its type in `lost` too, so the card tells that origin from one that got
        // no answer; like `unclear`, never a second copy.
        const lost = [...(prior?.lost ?? [])];
        if (result.origin === 'pending' && result.unclear && !lost.includes(result.unclear)) lost.push(result.unclear);
        // `unclearAt`: when the spend got no answer, for the card to tell a later problem from it — a repeated
        // outcome keeps the first one.
        const marker = unclear.length
            ? {
                  unclear,
                  unclearAt: result.unclear && !repeat ? at : prior?.unclearAt,
                  ...(lost.length ? { lost } : {}),
              }
            : {};
        next.inFlight = { ruleId, actionIndex: index, ...marker };
    }
    if (result.status !== 'deferred') next.lastError = { at, message };
    return applyEffects(next, { spent: result.spent, coins: result.coins }, at, noticeToken);
};

/**
 * The state after one step's outcome.
 *
 *   - `done`: the step's effects, the rule moved on to the next step, and the step recorded as the last action;
 *   - `skipped` in a committed rule: passed over (the rule carries on past it), recorded as the last problem;
 *   - any other not-done outcome: the rule stops there (stoppedAt).
 */
const reduceScenarioOutcome = (state: ScenarioState, step: ReducerStep, outcome: ActionOutcome): ScenarioState => {
    const { ruleId, index, actionType, at, committed, noticeToken, message } = step;
    if (outcome.status === 'done') {
        return {
            ...applyEffects(state, outcome, at, noticeToken),
            inFlight: { ruleId, actionIndex: index + 1 },
            lastAction: {
                at,
                ruleId,
                action: actionType,
                outcome: outcome.notDue === undefined ? 'done' : `not due: ${outcome.notDue}`,
            },
        };
    }
    if (outcome.status === 'skipped' && committed) {
        return { ...state, lastError: { at, message }, inFlight: { ruleId, actionIndex: index + 1 } };
    }
    return stoppedAt(state, step, outcome);
};

/**
 * The state when a rule has gone through all its steps: recorded as fired, with the phase change that was waiting
 * for it. A phase change takes effect when the rule finishes, so an interrupted rule always resumes in the phase it
 * belongs to. A step passed over in this firing stays visible as the last problem.
 *
 * @param startState - the state the rule began from (its phase clock is what the fired record keeps)
 * @param gotoPhase - the phase a `goto` step named, or null
 */
const finishScenarioRule = (
    before: ScenarioState,
    finish: {
        ruleId: string;
        startState: ScenarioState;
        gotoPhase: string | null;
        skippedStep: { at: number; message: string } | null;
        at: number;
        timezone: string;
    },
): ScenarioState => {
    const { ruleId, startState, gotoPhase, skippedStep, at, timezone } = finish;
    const state: ScenarioState = {
        ...before,
        inFlight: null,
        lastError: skippedStep,
        fired: { ...before.fired, [ruleId]: firedRecord(startState, at, timezone) },
    };
    if (gotoPhase === null || gotoPhase === state.phase) return state;
    // Leaving the phase drops what was patched for it: the next phase starts from its own settings.
    const left: ScenarioState = { ...state, phase: gotoPhase, phaseEnteredAt: at };
    delete left.phasePatch;
    delete left.phaseProfile;
    return left;
};

/**
 * A `pending` marker the step now running is not for (the scenario was edited since) is a spend that may have gone
 * through, and nothing will look at: it becomes an `unclear` one, counted, so that reverting the edit does not spend
 * it again.
 *
 * @param limitOf - the counter the marker's spend counts against
 */
const absorbLeftover = (
    state: ScenarioState,
    own: SpendAction | undefined,
    at: number,
    limitOf: (spend: SpendAction) => SpendKind,
): ScenarioState => {
    const { inFlight } = state;
    if (!inFlight?.pending || inFlight.pending === own) return state;
    const { pending, ...rest } = inFlight;
    return {
        ...state,
        spent: { ...state.spent, [limitOf(pending)]: (state.spent[limitOf(pending)] ?? 0) + 1 },
        inFlight: {
            ...rest,
            lost: [...(inFlight.lost ?? []), pending],
            unclear: [...(inFlight.unclear ?? []), pending],
            unclearAt: inFlight.unclearAt ?? at,
        },
    };
};

/** The operations a pass keeps one record of. */
type OperationKind = 'join' | 'claim' | 'vote' | 'boost' | 'turbo' | 'earn' | 'swap' | 'fill' | 'submit';

/**
 * The operation each action performs on its subject, for the actions that perform one the normal automation also does.
 */
const OPERATION_OF: Readonly<Record<string, OperationKind | undefined>> = {
    join: 'join',
    claimChallengeReward: 'claim',
    claimMissionReward: 'claim',
    enterPhoto: 'submit',
    swap: 'swap',
    boost: 'boost',
    turbo: 'turbo',
    earnTurbo: 'earn',
    fillExposure: 'fill',
    vote: 'vote',
};

/**
 * The operation each `runAutomation` operation performs, for the ones the normal automation keeps a record for (a key
 * unlock shows on the boost's own state, which the normal automation reads).
 */
const AUTOMATION_OPERATION_OF: Readonly<Record<string, OperationKind | undefined>> = {
    submit: 'submit',
    boost: 'boost',
    turbo: 'turbo',
    swap: 'swap',
    fillExposure: 'fill',
    vote: 'vote',
    join: 'join',
};

/**
 * Which operations were already done for which subject in one pass — by a scenario action or by the normal automation. Both
 * ask it before an operation and skip a duplicate. The subject is a challenge id, or `mission:<id>` for a mission.
 */
type OperationRecord = {
    has: (kind: OperationKind, subject: string) => boolean;
    mark: (kind: OperationKind, subject: string) => void;
};

const createOperationRecord = (): OperationRecord => {
    const done = new Set<string>();
    const key = (kind: OperationKind, subject: string) => `${kind}:${subject}`;
    return {
        has: (kind, subject) => done.has(key(kind, subject)),
        mark: (kind, subject) => {
            done.add(key(kind, subject));
        },
    };
};

export {
    withNotice,
    applyEffects,
    reduceScenarioOutcome,
    finishScenarioRule,
    absorbLeftover,
    createOperationRecord,
    OPERATION_OF,
    AUTOMATION_OPERATION_OF,
};
export type {
    ActionEffects,
    ActionOutcome,
    DoneOutcome,
    NotDoneOutcome,
    OperationKind,
    OperationRecord,
    ReducerStep,
    SpendKind,
};
