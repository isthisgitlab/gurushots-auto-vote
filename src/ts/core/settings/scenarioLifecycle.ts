/**
 * The lifecycle of a scenario assignment: what may change which scenario a subject runs, and what a change must leave
 * alone. A subject is a challenge or the installation (`@installation`, scenarioStateStore.ts).
 *
 *   - One mutation gate (a cross-process lock) serializes every change that can move an assignment or replace a
 *     definition. Under it the subjects the change touches are listed, their step locks are tried (never waited for),
 *     the configuration and the progress are read again, and the change is refused while a subject has unresolved
 *     work: a rule in progress, a spend that may have landed, a stopped rule, a handoff begun. Nothing is reset to make
 *     a change succeed. No lock is held across network I/O: the gate and the step locks cover storage work only.
 *   - The installation scenario is selected explicitly with an owner (executor) and a generation. Every change of the
 *     assignment or its owner advances the generation, in the progress record first, so that a former owner fails its
 *     next write; nothing takes ownership over by itself.
 *   - A handoff changes the scenario of one subject in three single writes: its intent in the progress record, the
 *     assignment, the finished record. Between any two of them no spend can happen (the intent holds the subject), and
 *     the runner finishes an interrupted one only when the assignment is still one the intent names.
 *   - The collection of definitions has a revision, advanced with every change of it in the same write; an overwrite
 *     states the revision it was made on and is refused as a conflict when the collection moved.
 *   - The priority Stop fence is a cell of its own: one small CAS, no other store read or written.
 *
 * A refusal is a typed result and nothing is written; a caller's unsaved draft stays as it was.
 */

import * as logger from '../logger';
import { clockSec } from '../simulationScope';
import { isPlainObject } from '../plainObject';
import { INSTALLATION_KEY, initialState, ledgerFor, refreshScenarioStateAsync } from '../scenarioStateStore';
import { isCount, isReservedSubject } from '../scenarioStateFile';
import { platform } from '../platform/port';
import { INSTALLATION_EXECUTORS } from './loadValidation';
import { loadSettings, saveSettings } from './persistence';
import { normalizeProfileName } from './profileStore';
import { findStoredScenario } from './scenarioLookup';
import { assignedScenarioIn, assignScenarioIn } from './challengeOverrides';
import { createJsonStore } from './storage';
import { runGated, unresolvedSpend, unresolvedWork } from './scenarioMutationGate';
import type { Plan } from './scenarioMutationGate';

import type { GateRefusal } from './scenarioMutationGate';
import type { ConfigV2, InstallationExecutor, InstallationScenarioV2 } from '../types/config';
import type { ScenarioState, ScenarioStopFence } from '../types/stores';
import type { ScenarioDocument } from './scenarioSchema';

const log = () => logger.withCategory('scenario');
const nowSec = clockSec;

/** The progress ledger of the mode a loaded configuration is in: mock mode never touches the persisted one. */
const ledgerOf = (settings: ConfigV2) => ledgerFor(settings.app.mock === true);

/** Why a change of one progress record did not land, as every caller words it: `busy`, `not-saved`, else the record could not be read. */
type RecordFailure = 'busy' | 'not-saved' | 'state-unreadable';
const recordFailure = (reason: string): RecordFailure =>
    reason === 'busy' || reason === 'not-saved' ? reason : 'state-unreadable';

/** The generation a subject is at: its record's, and for the installation the later of that and the configuration's. */
const generationOf = (settings: ConfigV2, subject: string, state: ScenarioState | null): number =>
    Math.max(
        state?.generation ?? 0,
        subject === INSTALLATION_KEY ? (settings.installationScenario?.generation ?? 0) : 0,
    );

// --- the installation scenario -----------------------------------------------------------------------------------------

/** The scenario selected for the installation and its owner, or null. */
const getInstallationScenario = (): InstallationScenarioV2 | null => {
    const { installationScenario } = loadSettings();
    return installationScenario ? { ...installationScenario } : null;
};

/**
 * The generation the installation assignment is at: the later of the configuration's and the progress record's (the
 * record is advanced first, so after an interrupted change it is the one ahead), 0 before any. Null when the progress
 * cannot be read: nothing can be said of a generation then.
 */
const installationGeneration = (): number | null => {
    const settings = loadSettings();
    const { corrupt, state } = ledgerOf(settings).get(INSTALLATION_KEY);
    return corrupt ? null : generationOf(settings, INSTALLATION_KEY, state);
};

type InstallationRefusal =
    | GateRefusal
    | 'stale-generation'
    | 'unknown-scenario'
    | 'incompatible-scope'
    | 'invalid-executor'
    | 'no-installation'
    | 'not-saved';

type InstallationResult =
    | { ok: true; installation: InstallationScenarioV2 | null; generation: number }
    | { ok: false; reason: InstallationRefusal; generation?: number };

const isExecutor = (value: unknown): value is InstallationExecutor =>
    INSTALLATION_EXECUTORS.some((executor) => executor === value);

/**
 * Moves the fence to `generation` in the installation's progress record, keeping its progress (or starting `scenario`
 * afresh when it is a different one). Written before the configuration, so that a former owner is fenced even when the
 * configuration then cannot be saved.
 */
const advanceInstallationRecord = (
    settings: ConfigV2,
    generation: number,
    scenario: ScenarioDocument | null,
): { ok: true } | { ok: false; reason: RecordFailure } => {
    const changed = ledgerOf(settings).change(INSTALLATION_KEY, (current) => {
        const same =
            scenario !== null &&
            current !== null &&
            normalizeProfileName(current.scenario) === normalizeProfileName(scenario.name);
        const base: ScenarioState = same
            ? { ...current }
            : scenario
              ? initialState(scenario.name, scenario.start, nowSec())
              : (current ?? initialState('', '', nowSec()));
        return { ...base, generation };
    });
    return changed.ok ? { ok: true } : { ok: false, reason: recordFailure(changed.reason) };
};

/**
 * Selects the installation scenario (`name`; null clears it) and its owner. Refused when the document is for challenges
 * (`incompatible-scope`), when `expectedGeneration` is not the current generation (`stale-generation`, with the current
 * one), and by the lifecycle preflight on the installation's progress. The generation advances by one either way.
 */
const setInstallationScenario = (
    name: string | null,
    executor: InstallationExecutor,
    expectedGeneration: number,
): InstallationResult => {
    if (!isExecutor(executor)) return { ok: false, reason: 'invalid-executor' };
    const gated = runGated(
        () => ({ installation: true }),
        (settings): InstallationResult => {
            // The gate read the installation's progress and found it readable.
            const generation = generationOf(settings, INSTALLATION_KEY, ledgerOf(settings).get(INSTALLATION_KEY).state);
            if (generation !== expectedGeneration) return { ok: false, reason: 'stale-generation', generation };
            const document = name === null ? null : findStoredScenario(settings, name);
            if (name !== null && document === null) return { ok: false, reason: 'unknown-scenario', generation };
            if (document && document.scope !== 'installation')
                return { ok: false, reason: 'incompatible-scope', generation };
            const next = generation + 1;
            const moved = advanceInstallationRecord(settings, next, document);
            if (!moved.ok) return { ok: false, reason: moved.reason, generation };
            const installation = document ? { scenario: document.name, executor, generation: next } : null;
            // `undefined`, not a deleted key: a save merges what it is given over what is stored, which a missing key leaves be.
            settings.installationScenario = installation ?? undefined;
            if (!saveSettings(settings)) return { ok: false, reason: 'not-saved', generation: next };
            log().info(installation ? 'Installation scenario selected' : 'Installation scenario cleared', null);
            return { ok: true, installation, generation: next };
        },
    );
    return gated.ok ? gated.value : { ok: false, reason: gated.reason };
};

/**
 * Hands the installation scenario to another executor: the same fence as setInstallationScenario, the progress kept
 * (a step that left a marker is the next owner's to reconcile), the generation advanced so the former owner fails its
 * next check. Nothing hands it over by itself.
 */
const transferInstallationOwner = (executor: InstallationExecutor, expectedGeneration: number): InstallationResult => {
    if (!isExecutor(executor)) return { ok: false, reason: 'invalid-executor' };
    const gated = runGated(
        () => ({ installation: true, requireIdle: false }),
        (settings): InstallationResult => {
            const { installationScenario } = settings;
            if (!installationScenario) return { ok: false, reason: 'no-installation' };
            const read = ledgerOf(settings).get(INSTALLATION_KEY);
            if (read.corrupt) return { ok: false, reason: 'state-unreadable' };
            const generation = generationOf(settings, INSTALLATION_KEY, read.state);
            if (generation !== expectedGeneration) return { ok: false, reason: 'stale-generation', generation };
            const document = findStoredScenario(settings, installationScenario.scenario);
            const next = generation + 1;
            const moved = advanceInstallationRecord(settings, next, document);
            if (!moved.ok) return { ok: false, reason: moved.reason, generation };
            const installation = { ...installationScenario, executor, generation: next };
            settings.installationScenario = installation;
            if (!saveSettings(settings)) return { ok: false, reason: 'not-saved', generation: next };
            log().info(`Installation scenario handed to ${executor}`, null);
            return { ok: true, installation, generation: next };
        },
    );
    return gated.ok ? gated.value : { ok: false, reason: gated.reason };
};

// --- handoff -----------------------------------------------------------------------------------------------------------

type HandoffRefusal =
    | GateRefusal
    | 'stale-generation'
    | 'unresolved-spend'
    | 'rule-in-progress'
    | 'handoff-pending'
    | 'incompatible-scope'
    | 'unknown-scenario'
    | 'invalid-subject'
    | 'no-progress'
    | 'no-installation'
    | 'assignment-unchanged'
    | 'not-saved';

type HandoffResult = { ok: true; generation: number } | { ok: false; reason: HandoffRefusal };

/** The assignment a subject has in a loaded configuration: the scenario's name, '' when none. */
const assignmentOf = (settings: ConfigV2, subject: string): string =>
    subject === INSTALLATION_KEY
        ? (settings.installationScenario?.scenario ?? '')
        : assignedScenarioIn(settings, subject);

/** Writes a subject's assignment onto a loaded configuration (the facade's own write); false when it cannot be made. */
const assign = (settings: ConfigV2, subject: string, name: string | null, generation: number): boolean => {
    if (subject !== INSTALLATION_KEY) return assignScenarioIn(settings, subject, name);
    if (name === null) {
        settings.installationScenario = undefined;
        return true;
    }
    if (!settings.installationScenario) return false;
    settings.installationScenario = { ...settings.installationScenario, scenario: name, generation };
    return true;
};

const HANDOFF_REASONS: readonly HandoffRefusal[] = [
    'stale-generation',
    'unresolved-spend',
    'rule-in-progress',
    'handoff-pending',
];

// What a record change declined with, as a handoff reason: a reason of the handoff itself, else why the record did not change.
const toHandoffRefusal = (reason: string): HandoffRefusal =>
    HANDOFF_REASONS.find((known) => known === reason) ?? recordFailure(reason);

/** The step of a rule that asks for the handoff (a `handoffScenario` action): the one rule in progress it may begin under. */
type HandoffFrom = { ruleId: string; actionIndex: number };

/** Why a handoff cannot begin on this record, in the order the reasons are weighed; null when it can. */
const handoffRefusal = (
    state: ScenarioState,
    generation: number,
    expected: number,
    from: HandoffFrom | undefined,
): HandoffRefusal | null => {
    if (generation !== expected) return 'stale-generation';
    if (unresolvedSpend(state)) return 'unresolved-spend';
    // A rule in progress holds the subject, unless it is the very step that asks for the handoff.
    const own =
        from !== undefined && state.inFlight?.ruleId === from.ruleId && state.inFlight.actionIndex === from.actionIndex;
    if (state.inFlight !== null && !own) return 'rule-in-progress';
    if (state.handoff) return 'handoff-pending';
    return null;
};

/** The record a finished handoff leaves: the next scenario at its start phase (or the progress kept when none follows). */
const finishedRecord = (state: ScenarioState, next: ScenarioDocument | null, generation: number): ScenarioState => {
    const base: ScenarioState = next ? initialState(next.name, next.start, nowSec()) : { ...state };
    delete base.published;
    delete base.publicationUnreadable;
    // What a phase of the old scenario patched does not outlive it, and the step that asked for the handoff is over.
    delete base.phasePatch;
    delete base.phaseProfile;
    delete base.phasePins;
    base.inFlight = null;
    return {
        ...base,
        generation,
        handoff: null,
        ...(state.paused ? { paused: state.paused } : {}),
        ...(state.withdrawn ? { withdrawn: state.withdrawn } : {}),
        ...(state.lastRequest ? { lastRequest: state.lastRequest } : {}),
    };
};

/** Step (c): finishes the intent, once the assignment stands. */
const finalizeHandoff = (
    settings: ConfigV2,
    subject: string,
    intent: NonNullable<ScenarioState['handoff']>,
    next: ScenarioDocument | null,
): { ok: true } | { ok: false; reason: RecordFailure | 'handoff-conflict' } => {
    const changed = ledgerOf(settings).change(subject, (current) =>
        current?.handoff &&
        current.handoff.generation === intent.generation &&
        (current.generation ?? 0) === intent.generation
            ? finishedRecord(current, next, intent.generation + 1)
            : { refuse: 'handoff-conflict' },
    );
    if (changed.ok) return { ok: true };
    return {
        ok: false,
        reason: changed.reason === 'handoff-conflict' ? 'handoff-conflict' : recordFailure(changed.reason),
    };
};

/**
 * Changes the scenario a subject runs (`nextName`; null: none) at a safe boundary, or refuses without writing anything
 * and without any call to GuruShots: unreadable progress (`state-unreadable`), a stale generation, a spend that may have
 * landed (`unresolved-spend`), a rule in progress, a handoff already begun, a document of the wrong scope. Otherwise it
 * writes the intent into the subject's progress record, changes the assignment, and finishes the record (the next
 * scenario starts at its start phase on the next pass, the generation one higher). If a write fails between the steps,
 * the subject stays held by its intent and the runner finishes it (settleHandoff).
 *
 * @param subject - a challenge id, or the installation (`@installation`)
 * @param expectedGeneration - the generation the caller saw
 * @param from - the step of the rule that asks for it (a `handoffScenario` action), which may be the rule in progress
 */
const requestScenarioHandoff = async (
    subject: string,
    nextName: string | null,
    expectedGeneration: number,
    from?: HandoffFrom,
): Promise<HandoffResult> => {
    if (subject === '' || isReservedSubject(subject)) return { ok: false, reason: 'invalid-subject' };
    // Mock mode keeps its progress in memory: the persisted store is not read.
    if (loadSettings().app.mock !== true) await refreshScenarioStateAsync();
    const plan: Plan =
        subject === INSTALLATION_KEY
            ? { installation: true, requireIdle: false }
            : { challengeIds: [subject], requireIdle: false };
    const gated = runGated(
        () => plan,
        (settings): HandoffResult => {
            if (subject === INSTALLATION_KEY && !settings.installationScenario) {
                return { ok: false, reason: 'no-installation' };
            }
            const ledger = ledgerOf(settings);
            const { corrupt, state } = ledger.get(subject);
            if (corrupt) return { ok: false, reason: 'state-unreadable' };
            if (state === null) return { ok: false, reason: 'no-progress' };
            const refused = handoffRefusal(state, generationOf(settings, subject, state), expectedGeneration, from);
            if (refused) return { ok: false, reason: refused };
            const next = nextName === null ? null : findStoredScenario(settings, nextName);
            if (nextName !== null && next === null) return { ok: false, reason: 'unknown-scenario' };
            const wanted: ScenarioDocument['scope'] = subject === INSTALLATION_KEY ? 'installation' : 'challenge';
            if (next && (next.scope ?? 'challenge') !== wanted) return { ok: false, reason: 'incompatible-scope' };
            // A rule or a profile that sets the challenge's scenario would still decide it: nothing is begun then.
            const probe = structuredClone(settings);
            if (
                !assign(probe, subject, next?.name ?? null, expectedGeneration + 1) ||
                normalizeProfileName(assignmentOf(probe, subject)) !== normalizeProfileName(next?.name)
            ) {
                return { ok: false, reason: 'assignment-unchanged' };
            }
            const intent = {
                from: state.scenario,
                to: next?.name ?? null,
                generation: expectedGeneration,
                at: nowSec(),
            };
            // (a) the intent: from here on the subject runs nothing, whatever fails next.
            const written = ledger.change(subject, (current) => {
                if (!current) return { refuse: 'stale-generation' };
                const again = handoffRefusal(
                    current,
                    generationOf(settings, subject, current),
                    expectedGeneration,
                    from,
                );
                return again ? { refuse: again } : { ...current, handoff: intent };
            });
            if (!written.ok) return { ok: false, reason: toHandoffRefusal(written.reason) };
            // (b) the assignment.
            if (!assign(settings, subject, intent.to, expectedGeneration + 1) || !saveSettings(settings)) {
                log().error('scenario handoff: the new assignment could not be saved — the subject stays held', null);
                return { ok: false, reason: 'not-saved' };
            }
            // (c) the finished record.
            const finished = finalizeHandoff(settings, subject, intent, next);
            // An intent that changed under the finish is another writer's: the generation the caller saw is stale.
            if (!finished.ok) {
                return {
                    ok: false,
                    reason: finished.reason === 'handoff-conflict' ? 'stale-generation' : finished.reason,
                };
            }
            return { ok: true, generation: expectedGeneration + 1 };
        },
    );
    return gated.ok ? gated.value : { ok: false, reason: gated.reason };
};

/** What the runner finds on a subject with a handoff intent. */
type HandoffSettlement = 'finished' | 'conflict' | 'failed';

/**
 * Finishes an interrupted handoff of `subject`, for the runner to call under the subject's step lock before anything
 * else: when the assignment is the intent's `to` the record is finished; when it is still the `from` the assignment is
 * made again and the record finished. Anything else (a third assignment, another generation) is a conflict, which the
 * runner reports and runs nothing for. `failed`: a write did not land; the intent stands and holds the subject.
 */
const settleHandoff = (subject: string, state: ScenarioState): HandoffSettlement => {
    const intent = state.handoff;
    if (!intent) return 'finished';
    const settings = loadSettings();
    if ((state.generation ?? 0) !== intent.generation) return 'conflict';
    const next = intent.to === null ? null : findStoredScenario(settings, intent.to);
    if (intent.to !== null && next === null) return 'conflict';
    const stands = normalizeProfileName(assignmentOf(settings, subject));
    if (stands !== normalizeProfileName(intent.to)) {
        if (stands !== normalizeProfileName(intent.from)) return 'conflict';
        if (!assign(settings, subject, intent.to, intent.generation + 1) || !saveSettings(settings)) return 'failed';
        if (normalizeProfileName(assignmentOf(loadSettings(), subject)) !== normalizeProfileName(intent.to))
            return 'failed';
    }
    return finalizeHandoff(settings, subject, intent, next).ok ? 'finished' : 'failed';
};

// --- pause and resume ---------------------------------------------------------------------------------------------------

type PauseResult =
    | { ok: true; paused: boolean }
    | { ok: false; reason: GateRefusal | 'invalid-subject' | 'no-progress' | 'not-saved' };

/**
 * The user's pause and resume of one subject (a challenge, or the installation): `paused: true` writes `{ at, reason }`,
 * `paused: false` clears it. Progress is kept as it is. It takes the subject's step lock without waiting (`busy` while a step
 * or another change holds it), and touches neither Manual Only nor the Stop fence. Resuming a subject that is not paused is a
 * success that writes nothing. (The `pauseScenario` action pauses through the runner's own write; only this function resumes.)
 *
 * @param subject - a challenge id, or the installation (`@installation`)
 */
const setScenarioPaused = (subject: string, paused: boolean, reason = ''): PauseResult => {
    if (subject === '' || isReservedSubject(subject)) return { ok: false, reason: 'invalid-subject' };
    const plan: Plan =
        subject === INSTALLATION_KEY
            ? { installation: true, requireIdle: false }
            : { challengeIds: [subject], requireIdle: false };
    const gated = runGated(
        () => plan,
        (settings): PauseResult => {
            const ledger = ledgerOf(settings);
            const { corrupt, state } = ledger.get(subject);
            if (corrupt) return { ok: false, reason: 'state-unreadable' };
            if (state === null) return { ok: false, reason: 'no-progress' };
            if (!paused && !state.paused) return { ok: true, paused: false };
            const changed = ledger.change(subject, (current) => {
                if (!current) return { refuse: 'no-progress' };
                if (paused) return { ...current, paused: { at: nowSec(), reason } };
                const resumed = { ...current };
                delete resumed.paused;
                return resumed;
            });
            if (!changed.ok) return { ok: false, reason: recordFailure(changed.reason) };
            log().info(`Scenario of ${subject} ${paused ? 'paused' : 'resumed'}`, null);
            return { ok: true, paused };
        },
    );
    return gated.ok ? gated.value : { ok: false, reason: gated.reason };
};

// --- withdrawal of the installation's publication on a full Stop ----------------------------------------------------------

type WithdrawalResult = { ok: true; changed: boolean } | { ok: false; reason: 'state-unreadable' | 'not-saved' };

/**
 * A full Stop's withdrawal: marks the installation's record `withdrawn: { at, epoch }` and drops its publication, so every
 * installation setting reads its saved value at once. Phase and progress are kept. It never waits: one short change under the
 * ledger's own lock, no gate and no step lock (a Stop is refused by nothing). No record (the installation scenario never ran) has
 * nothing to withdraw.
 */
const withdrawInstallationPublication = (epoch: number, at: number = nowSec()): WithdrawalResult => {
    const ledger = ledgerOf(loadSettings());
    const { corrupt, state } = ledger.get(INSTALLATION_KEY);
    if (corrupt) return { ok: false, reason: 'state-unreadable' };
    if (state === null) return { ok: true, changed: false };
    const changed = ledger.change(INSTALLATION_KEY, (current) => {
        if (!current) return { refuse: 'no-progress' };
        const next: ScenarioState = { ...current, withdrawn: { at, epoch } };
        delete next.published;
        delete next.publicationUnreadable;
        return next;
    });
    return changed.ok ? { ok: true, changed: true } : { ok: false, reason: 'not-saved' };
};

/**
 * An explicit user re-arm lifts the withdrawal, before the next publication. Nothing else lifts it. A record that was not
 * withdrawn is left as it is.
 */
const restoreInstallationPublication = (): WithdrawalResult => {
    const ledger = ledgerOf(loadSettings());
    const { corrupt, state } = ledger.get(INSTALLATION_KEY);
    if (corrupt) return { ok: false, reason: 'state-unreadable' };
    if (!state?.withdrawn) return { ok: true, changed: false };
    const changed = ledger.change(INSTALLATION_KEY, (current) => {
        if (!current?.withdrawn) return { refuse: 'not-withdrawn' };
        const next = { ...current };
        delete next.withdrawn;
        return next;
    });
    return changed.ok ? { ok: true, changed: true } : { ok: false, reason: 'not-saved' };
};

// --- the priority Stop fence -------------------------------------------------------------------------------------------

const STOP_FENCE_KEY = 'gs_scenario_stop_fence';
const STOP_FENCE_MAX_BYTES = 1024;

// `shared`: the Android service writes this key too. `strict`: a Stop the native bridge did not persist is a failed one.
const stopFenceStore = createJsonStore({
    fileName: 'scenarioStopFence.json',
    prefKey: STOP_FENCE_KEY,
    atomic: true,
    strict: true,
    shared: true,
});

type StopFenceRead =
    | { state: 'ok'; fence: ScenarioStopFence }
    | { state: 'missing' }
    | { state: 'unreadable'; reason: 'not-loaded' | 'oversize' | 'malformed' | 'read-failed' };

const FENCE_KEYS = ['stopEpoch', 'blocked', 'lastStop', 'lastArm'];
const LAST_STOP_KEYS = ['requestId', 'at', 'durable'];
const LAST_ARM_KEYS = ['epoch', 'at'];

const hasOnly = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

/** The fence a text holds: exactly the shape, or null. */
const parseFence = (raw: string): ScenarioStopFence | null => {
    let value: unknown;
    try {
        value = JSON.parse(raw);
    } catch {
        return null;
    }
    if (!isPlainObject(value) || !hasOnly(value, FENCE_KEYS)) return null;
    const { stopEpoch, blocked, lastStop, lastArm } = value;
    if (!isCount(stopEpoch) || typeof blocked !== 'boolean') return null;
    let arm: ScenarioStopFence['lastArm'] = null;
    if (lastArm !== null) {
        if (
            !isPlainObject(lastArm) ||
            !hasOnly(lastArm, LAST_ARM_KEYS) ||
            !isCount(lastArm.epoch) ||
            !Number.isFinite(lastArm.at)
        ) {
            return null;
        }
        arm = { epoch: lastArm.epoch, at: Number(lastArm.at) };
    }
    if (lastStop === null) return { stopEpoch, blocked, lastStop: null, lastArm: arm };
    if (
        !isPlainObject(lastStop) ||
        !hasOnly(lastStop, LAST_STOP_KEYS) ||
        typeof lastStop.requestId !== 'string' ||
        !Number.isFinite(lastStop.at) ||
        typeof lastStop.durable !== 'boolean'
    ) {
        return null;
    }
    return {
        stopEpoch,
        blocked,
        lastStop: { requestId: lastStop.requestId, at: Number(lastStop.at), durable: lastStop.durable },
        lastArm: arm,
    };
};

/** The text a fence is stored as, or null when it would not fit the cell. */
const fenceText = (fence: ScenarioStopFence): string | null => {
    const text = JSON.stringify(fence);
    return new TextEncoder().encode(text).length <= STOP_FENCE_MAX_BYTES ? text : null;
};

const readFenceText = (raw: string | null): StopFenceRead => {
    if (raw === null) return { state: 'missing' };
    if (new TextEncoder().encode(raw).length > STOP_FENCE_MAX_BYTES) return { state: 'unreadable', reason: 'oversize' };
    const fence = parseFence(raw);
    return fence ? { state: 'ok', fence } : { state: 'unreadable', reason: 'malformed' };
};

/**
 * The fence as stored: `ok`, `missing` (never created), or `unreadable` with why. Malformed data is never an epoch of 0:
 * nothing may be armed on an unreadable fence.
 */
const readStopFence = (): StopFenceRead => {
    try {
        const raw = stopFenceStore.readRaw();
        // After the read: a read that failed says so only once it was made.
        if (!platform().storage.loaded(STOP_FENCE_KEY)) return { state: 'unreadable', reason: 'not-loaded' };
        return readFenceText(raw);
    } catch {
        return { state: 'unreadable', reason: 'read-failed' };
    }
};

type StopFenceFailure = 'unreadable' | 'oversize' | 'not-saved';

/**
 * Creates the fence `{ stopEpoch: 0, blocked: false }` when none exists; a fence that exists is left as it is.
 */
const initializeStopFence = async (): Promise<
    { ok: true; created: boolean } | { ok: false; reason: StopFenceFailure }
> => {
    const initial = fenceText({ stopEpoch: 0, blocked: false, lastStop: null, lastArm: null }) as string;
    const saved = await stopFenceStore
        .updateThrough((current) => (current === null ? initial : null))
        .catch(() => 'failed' as const);
    if (saved === 'failed') return { ok: false, reason: 'not-saved' };
    return readStopFence().state === 'ok'
        ? { ok: true, created: saved === 'saved' }
        : { ok: false, reason: 'unreadable' };
};

/**
 * Records a full Stop: the epoch one higher and `blocked`, in one short compare-and-set on the fence alone: no other store
 * is read or written, so nothing else can refuse it. The same request recorded twice advances the epoch once. A fence
 * that cannot be read is not written over (its epoch is unknown): `unreadable`.
 */
const recordFullStop = async (
    requestId: string,
    at: number,
): Promise<{ ok: true; epoch: number } | { ok: false; reason: StopFenceFailure }> => {
    const out: { epoch: number; reason: StopFenceFailure | null } = { epoch: 0, reason: null };
    const saved = await stopFenceStore
        .updateThrough((current) => {
            const read = readFenceText(current);
            if (read.state === 'unreadable') {
                out.reason = 'unreadable';
                return null;
            }
            const before =
                read.state === 'ok' ? read.fence : { stopEpoch: 0, blocked: false, lastStop: null, lastArm: null };
            if (before.lastStop?.requestId === requestId) {
                out.epoch = before.stopEpoch;
                return null;
            }
            const text = fenceText({
                stopEpoch: before.stopEpoch + 1,
                blocked: true,
                lastStop: { requestId, at, durable: true },
                lastArm: before.lastArm,
            });
            if (text === null) {
                out.reason = 'oversize';
                return null;
            }
            out.epoch = before.stopEpoch + 1;
            return text;
        })
        .catch(() => 'failed' as const);
    if (saved === 'failed') return { ok: false, reason: 'not-saved' };
    return out.reason ? { ok: false, reason: out.reason } : { ok: true, epoch: out.epoch };
};

/**
 * Lifts the block of a Stop, only while the epoch is still `expectedEpoch` (the one the user acknowledged): a Stop that came
 * after leaves it blocked (`stale-epoch`). This function checks the epoch only; that the call is the user's own Run,
 * Resume or re-arm, and not a scenario, a startup or an alarm, is the caller's authority to establish (the controller
 * route, scenario-expansion P09): nothing here can tell.
 */
const clearStopBlock = async (
    expectedEpoch: number,
): Promise<{ ok: true } | { ok: false; reason: StopFenceFailure | 'stale-epoch' | 'missing' }> => {
    const out: { reason: StopFenceFailure | 'stale-epoch' | 'missing' | null } = { reason: null };
    const saved = await stopFenceStore
        .updateThrough((current) => {
            const read = readFenceText(current);
            if (read.state !== 'ok') {
                out.reason = read.state === 'missing' ? 'missing' : 'unreadable';
                return null;
            }
            if (read.fence.stopEpoch !== expectedEpoch) {
                out.reason = 'stale-epoch';
                return null;
            }
            // Already open: nothing to write.
            return read.fence.blocked ? fenceText({ ...read.fence, blocked: false }) : null;
        })
        .catch(() => 'failed' as const);
    if (saved === 'failed') return { ok: false, reason: 'not-saved' };
    return out.reason ? { ok: false, reason: out.reason } : { ok: true };
};

/**
 * The final arming decision, in one compare-and-set on the fence alone: it succeeds only while the fence is readable, not
 * `blocked`, and still at `capturedEpoch`, and it writes `lastArm` in the same step. A Stop that advanced the epoch first, or
 * lands after, cannot be overtaken: the write is refused (`stale-epoch` / `blocked`) or is followed by the Stop's own advance.
 * Nothing but the fence is read or written.
 */
const armIfAllowed = async (
    capturedEpoch: number,
    at: number,
): Promise<{ ok: true } | { ok: false; reason: StopFenceFailure | 'stale-epoch' | 'blocked' | 'missing' }> => {
    const out: { reason: StopFenceFailure | 'stale-epoch' | 'blocked' | 'missing' | null } = { reason: null };
    const saved = await stopFenceStore
        .updateThrough((current) => {
            const read = readFenceText(current);
            if (read.state !== 'ok') {
                out.reason = read.state === 'missing' ? 'missing' : 'unreadable';
                return null;
            }
            if (read.fence.blocked) {
                out.reason = 'blocked';
                return null;
            }
            if (read.fence.stopEpoch !== capturedEpoch) {
                out.reason = 'stale-epoch';
                return null;
            }
            const text = fenceText({ ...read.fence, lastArm: { epoch: capturedEpoch, at } });
            if (text === null) {
                out.reason = 'oversize';
                return null;
            }
            return text;
        })
        .catch(() => 'failed' as const);
    if (saved === 'failed') return { ok: false, reason: 'not-saved' };
    return out.reason ? { ok: false, reason: out.reason } : { ok: true };
};

/** Whether arming is allowed for a request that captured `capturedEpoch`: the fence reads, is not blocked, and has not moved. */
const isArmAllowed = (capturedEpoch: number): boolean => {
    const read = readStopFence();
    return read.state === 'ok' && !read.fence.blocked && read.fence.stopEpoch === capturedEpoch;
};

const initializeStopFenceAsync = (): Promise<void> => stopFenceStore.initializeAsync();
const flushStopFenceWrites = (): Promise<void> => stopFenceStore.flushPendingWrites();

export {
    STOP_FENCE_KEY,
    STOP_FENCE_MAX_BYTES,
    unresolvedWork,
    getInstallationScenario,
    installationGeneration,
    setInstallationScenario,
    transferInstallationOwner,
    requestScenarioHandoff,
    setScenarioPaused,
    settleHandoff,
    readStopFence,
    initializeStopFence,
    recordFullStop,
    clearStopBlock,
    armIfAllowed,
    withdrawInstallationPublication,
    restoreInstallationPublication,
    isArmAllowed,
    initializeStopFenceAsync,
    flushStopFenceWrites,
};
export type { PauseResult, HandoffResult, InstallationResult, StopFenceRead };
