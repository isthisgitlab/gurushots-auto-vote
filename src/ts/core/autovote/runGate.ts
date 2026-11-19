/**
 * The run gate: the one place that decides whether a request to arm or continue unattended execution may still do so, and
 * what a full user Stop does to every request that came before it. Dependency-free on purpose (type-only imports): the
 * WebView controller and the Node scheduler both build one.
 *
 * Two latches work together:
 *
 *   - the local generation, advanced synchronously, first of all, by `latch()` when a full Stop is received. A request
 *     captured the generation when it was created; once the generation moved the request is obsolete in this process, with
 *     no storage involved, and whatever happens to the durable fence afterwards;
 *   - the durable Stop fence (settings/scenarioLifecycle.ts, the priority cell): `stopEpoch` and `blocked`. A request also
 *     captured the epoch; at the arm and dispatch boundary it is checked against the fence, so a Stop recorded by another
 *     executor, or before a restart, obsoletes it too.
 *
 * The final arming decision (a Run, a startup resume, a scenario's request to turn the voting stages on) is one compare-and-set
 * on the fence (`armIfAllowed`): it succeeds only while the fence is readable, not `blocked`, and still at the captured epoch,
 * and a Stop racing it either goes first (the arm is refused) or after (its own advance follows). The local generation is
 * checked before and after as well, and the caller re-checks `current` in the same synchronous step that arms. A timer's
 * dispatch only reads the fence (`admits`): a write per cycle is not needed to refuse a stale timer.
 *
 * Authority: only `admitUser` (the user's own Run / Resume, reached through the controller's `start` and nothing a request
 * can claim for itself) may lift `blocked`. `admits` never does, so a startup resume, a scenario request and a timer cannot.
 */

import type { StopFenceRead } from '../settings';
import type { RunCapture } from '../scheduling/cadenceChain/types';

type FenceFailure = 'unreadable' | 'oversize' | 'not-saved';

/** The priority Stop fence as the gate uses it (the settings facade on Node; a host-supplied transport in the WebView). */
type StopFencePort = {
    read: () => StopFenceRead | Promise<StopFenceRead>;
    initialize: () => Promise<{ ok: true; created: boolean } | { ok: false; reason: FenceFailure }>;
    recordFullStop: (
        requestId: string,
        at: number,
    ) => Promise<{ ok: true; epoch: number } | { ok: false; reason: FenceFailure }>;
    clearStopBlock: (
        expectedEpoch: number,
    ) => Promise<{ ok: true } | { ok: false; reason: FenceFailure | 'stale-epoch' | 'missing' }>;
    isArmAllowed: (capturedEpoch: number) => boolean | Promise<boolean>;
    armIfAllowed: (
        capturedEpoch: number,
        at: number,
    ) => Promise<{ ok: true } | { ok: false; reason: FenceFailure | 'stale-epoch' | 'blocked' | 'missing' }>;
};

/**
 * What the fence made of a full Stop. `stopped`: cancelled here and recorded in the durable fence. `stopped-locally`: cancelled
 * here, and not recorded (`no-fence` where the host has no fence; otherwise the fence could not be saved or read): other
 * executors and a restart are not protected.
 */
type FenceStop =
    | { outcome: 'stopped'; durable: true; epoch: number }
    | { outcome: 'stopped-locally'; durable: false; reason: 'no-fence' | FenceFailure };

/**
 * What the withdrawal of the installation's publication came to: `withdrawn`, `none` (nothing was published), `failed` (the
 * write did not land: the installation's settings may still read the published values), `no-route` (this host has none).
 */
type WithdrawalOutcome = 'withdrawn' | 'none' | 'failed' | 'no-route';

/**
 * What a full Stop came to: the fence's answer and the withdrawal's, each reported as it was; neither undoes the local
 * cancellation. `requested`: a remote client sent it and the host's answer is not in yet.
 */
type StopResult = (FenceStop & { withdrawal: WithdrawalOutcome }) | { outcome: 'requested'; durable: false };

/** Why a user's Run / Resume was not admitted. */
type AdmitRefusal =
    | 'superseded'
    | 'stop-not-saved'
    | 'fence-unreadable'
    | 'stop-epoch-moved'
    | 'block-not-cleared'
    | 'arm-refused'
    | 'no-armed-cycle';

type AdmitResult = { ok: true; capture: RunCapture } | { ok: false; reason: AdmitRefusal };

type RunGate = {
    /** The request's capture: the local generation now, and the epoch last acknowledged (null where none is known). Synchronous. */
    capture: () => RunCapture;
    /** A capture that also reads the fence now (a startup or scenario request); null when the fence cannot be read. */
    captureFresh: () => Promise<RunCapture | null>;
    /** The capture of the run that is armed now (what its timers carry). */
    run: () => RunCapture;
    /** Whether the host has a fence at all: without one, admission is synchronous and local. */
    fenced: boolean;
    /** Admission where the host has no fence: synchronous (a user's Run flips the state at once), refused only when obsolete. */
    admitLocal: (route: 'user' | 'startup', capture: RunCapture) => AdmitResult;
    /** The user's own Run / Resume: refuses what is obsolete, lifts `blocked` only here, and arms the run capture. */
    admitUser: (capture: RunCapture) => Promise<AdmitResult>;
    /** A startup resume: arms the run capture when the request is still current and the fence allows it (the CAS); never lifts `blocked`. */
    admitUnattended: (capture: RunCapture) => Promise<AdmitResult>;
    /** The CAS alone, for a scenario's request to turn the voting stages on under the run that is armed: true when it may. */
    armsAt: (capture: RunCapture) => Promise<boolean>;
    /** Whether a request or timer that holds `capture` may arm or dispatch: not obsolete here, and allowed by the fence. */
    admits: (capture: RunCapture) => Promise<boolean>;
    /** Synchronous: whether `capture` is still current in this process. The arm step re-checks it. */
    current: (capture: RunCapture) => boolean;
    /** Local cancellation, first of all and synchronous: every request captured before it is obsolete from here. */
    latch: () => void;
    /** Records the Stop in the fence (after `latch`). Never throws. */
    persistStop: (requestId: string, at: number) => Promise<FenceStop>;
    /** The epoch last acknowledged (read or recorded here), or null. */
    knownEpoch: () => number | null;
};

const createRunGate = (port: StopFencePort | null | undefined): RunGate => {
    let generation = 0;
    let latched = false;
    let known: number | null = null;
    let armed: RunCapture = { epoch: null, generation: 0 };
    // A Stop whose fence write failed: the next user Run records it first (a process that could not save its Stop does not run again).
    let unsaved: { requestId: string; at: number } | null = null;

    const moved = (capture: RunCapture): boolean => capture.generation !== generation;

    /** The fence as stored, created first when it was never created. Null when it cannot be read. */
    const readFence = async (
        fenced: StopFencePort,
    ): Promise<Extract<StopFenceRead, { state: 'ok' }>['fence'] | null> => {
        let read = await fenced.read();
        if (read.state === 'missing') {
            const created = await fenced.initialize();
            if (!created.ok) return null;
            read = await fenced.read();
        }
        return read.state === 'ok' ? read.fence : null;
    };

    const capture = (): RunCapture => ({ epoch: known, generation });

    const captureFresh = async (): Promise<RunCapture | null> => {
        const at = generation;
        if (!port) return { epoch: null, generation: at };
        const fence = await readFence(port);
        if (!fence) return null;
        known = fence.stopEpoch;
        return { epoch: fence.stopEpoch, generation: at };
    };

    const admitLocal = (route: 'user' | 'startup', request: RunCapture): AdmitResult => {
        if (moved(request) || (route === 'startup' && latched)) return { ok: false, reason: 'superseded' };
        if (route === 'user') latched = false;
        armed = { epoch: null, generation };
        return { ok: true, capture: armed };
    };

    const admitUser = async (request: RunCapture): Promise<AdmitResult> => {
        if (!port) return admitLocal('user', request);
        if (moved(request)) return { ok: false, reason: 'superseded' };
        if (unsaved) {
            const saved = await port.recordFullStop(unsaved.requestId, unsaved.at);
            if (!saved.ok) return { ok: false, reason: 'stop-not-saved' };
            known = saved.epoch;
            unsaved = null;
        }
        const fence = await readFence(port);
        if (!fence) return { ok: false, reason: 'fence-unreadable' };
        // A Stop that arrived while the fence was read: an obsolete request lifts nothing.
        if (moved(request)) return { ok: false, reason: 'superseded' };
        // A Stop the user has not seen (another executor's, or one since the last acknowledgment) is not theirs to lift.
        if (known !== null && fence.stopEpoch !== known) {
            known = fence.stopEpoch;
            return { ok: false, reason: 'stop-epoch-moved' };
        }
        if (fence.blocked) {
            const cleared = await port.clearStopBlock(fence.stopEpoch);
            if (!cleared.ok) return { ok: false, reason: 'block-not-cleared' };
        }
        // A Stop that arrived while the fence was read and cleared makes this request obsolete: nothing arms.
        if (moved(request)) return { ok: false, reason: 'superseded' };
        // The final decision, in one CAS: a Stop that advanced the epoch since the read refuses it.
        const armedAt = await port.armIfAllowed(fence.stopEpoch, Date.now());
        if (!armedAt.ok) return { ok: false, reason: 'arm-refused' };
        if (moved(request)) return { ok: false, reason: 'superseded' };
        known = fence.stopEpoch;
        latched = false;
        armed = { epoch: fence.stopEpoch, generation };
        return { ok: true, capture: armed };
    };

    const admits = async (request: RunCapture): Promise<boolean> => {
        if (moved(request) || latched) return false;
        if (!port) return true;
        if (request.epoch === null) return false;
        const allowed = await port.isArmAllowed(request.epoch);
        return allowed && !moved(request) && !latched;
    };

    const armsAt = async (request: RunCapture): Promise<boolean> => {
        if (moved(request) || latched) return false;
        if (!port) return true;
        if (request.epoch === null) return false;
        const armedAt = await port.armIfAllowed(request.epoch, Date.now());
        return armedAt.ok && !moved(request) && !latched;
    };

    const admitUnattended = async (request: RunCapture): Promise<AdmitResult> => {
        if (!(await armsAt(request))) return { ok: false, reason: 'superseded' };
        armed = request;
        return { ok: true, capture: request };
    };

    const latch = (): void => {
        generation += 1;
        latched = true;
    };

    const persistStop = async (requestId: string, at: number): Promise<FenceStop> => {
        if (!port) return { outcome: 'stopped-locally', durable: false, reason: 'no-fence' };
        try {
            const saved = await port.recordFullStop(requestId, at);
            if (saved.ok) {
                known = saved.epoch;
                unsaved = null;
                return { outcome: 'stopped', durable: true, epoch: saved.epoch };
            }
            unsaved = { requestId, at };
            return { outcome: 'stopped-locally', durable: false, reason: saved.reason };
        } catch {
            unsaved = { requestId, at };
            return { outcome: 'stopped-locally', durable: false, reason: 'not-saved' };
        }
    };

    return {
        capture,
        captureFresh,
        fenced: port != null,
        admitLocal,
        run: () => armed,
        admitUser,
        admitUnattended,
        armsAt,
        admits,
        current: (request) => !moved(request) && !latched,
        latch,
        persistStop,
        knownEpoch: () => known,
    };
};

export { createRunGate };
export type {
    StopFencePort,
    StopResult,
    FenceStop,
    WithdrawalOutcome,
    AdmitRefusal,
    AdmitResult,
    RunGate,
    FenceFailure,
};
