/**
 * The phone's autovote controller: the same `AutovoteController` surface the desktop
 * controller exposes, but with no timer of its own. Its state arrives relayed from the
 * desktop host (`autovote-state` messages); start/stop/rearm go to the desktop as
 * `autovote-command` messages; `maybeResume` does nothing, because there is nothing local to
 * resume — the desktop holds the one voting timer, so a phone can never start a second one.
 *
 * Every command carries a request identity. A Stop is the priority operation: the phone shows it as `requested` (pending,
 * unconfirmed) from the send until the host's acknowledgment of that identity, or a fresh stopped state with a higher Stop
 * epoch, arrives — a lost reply or a lost connection never turns it into success. A Start or re-arm also carries the Stop epoch
 * of the state the phone saw, so the host refuses one a Stop has overtaken; the phone never sends a command a second time.
 *
 * Built by `AutovoteProvider` when the platform kind is `remote`, never
 * `createAutovoteController` — the remote shell has no window.api-backed voting loop.
 */

import { ACTIONS, autovoteReducer, initialState } from './state';
import { remoteConnectionState, remoteHostPeerId } from '../remote/connectionState';
import { parsePeerMessage } from '../remote/protocol';
import { classifyRemoteCommand } from '../remote/allowlist';
import { newRequestId } from '../remote/requestId';
import { rendererTranslator } from '../translations/renderer';

import type { RemoteTransport } from '../remote/relays';
import type { AutovoteCommandName } from '../remote/protocol';
import type { StopResult } from './runGate';
import type { AutovoteState } from './state';
import type { AutovoteController } from './types';

export type RemoteAutovoteDeps = {
    /** The shared peer transport (the same one the peer bridge uses). */
    transport: RemoteTransport;
    /** Read on each relayed cycle change, so the caller's latest identity is the one called. */
    getOnChallengesRefresh: () => (() => unknown) | undefined;
};

/** What a Stop the host has not answered yet reads as on the phone. */
const REQUESTED: StopResult = { outcome: 'requested', durable: false };

/** Whether a host state shows a Stop newer than the epoch the phone knew: stopped, and under a higher epoch. */
const stoppedSince = (next: AutovoteState, epoch: number | null): boolean =>
    next.executionMode === 'stopped' && next.stopEpoch !== null && (epoch === null || next.stopEpoch > epoch);

export const createRemoteAutovoteController = (deps: RemoteAutovoteDeps): AutovoteController => {
    let state: AutovoteState = initialState;
    const listeners = new Set<() => void>();
    let disposed = false;
    /** The desktop run and count of the newest state applied: an older count of the same run is a stale push, ignored. */
    let appliedRun: string | null = null;
    let appliedCount = -1;
    /** Orders the commands as the phone sent them, so a Stop knows whether it came after a Run. */
    let commandOrder = 0;
    /** The Stop sent and not yet answered: its identity, the Stop epoch the phone knew when it sent it, and its order. */
    let pendingStop: { requestId: string; epoch: number | null; order: number } | null = null;
    /** The Run / Resume sent and not yet answered: the host has not said what it did, and the phone's Stop stays within reach. */
    let pendingStart: { requestId: string; order: number } | null = null;

    const apply = (next: AutovoteState): void => {
        state = next;
        for (const listener of listeners) listener();
    };

    const notConnected = (): void =>
        // The command would reach nobody. Say so on the status instead of resolving as if it ran.
        apply(
            autovoteReducer(state, {
                type: ACTIONS.SET_ERROR,
                payload: rendererTranslator.t('errors.remoteNotConnected'),
            }),
        );

    const sendCommand = async (command: AutovoteCommandName): Promise<void> => {
        if (disposed) return;
        if (remoteConnectionState() !== 'connected') {
            notConnected();
            return;
        }
        const requestId = newRequestId();
        const epoch = state.stopEpoch;
        const order = ++commandOrder;
        if (classifyRemoteCommand(command) === 'priority-stop') {
            // Pending, not stopped: the host has not said what it did.
            pendingStop = { requestId, epoch, order };
            apply(autovoteReducer(state, { type: ACTIONS.SET_STOP_RESULT, payload: REQUESTED }));
        } else if (command === 'start') {
            pendingStart = { requestId, order };
            // A new object, so a subscriber that compares states sees the change.
            apply({ ...state });
        }
        const message = {
            t: 'autovote-command',
            command,
            requestId,
            ...(command !== 'stop' && epoch !== null ? { expectedStopEpoch: epoch } : {}),
        };
        try {
            // The hybrid transport takes no send without a target: the desktop it is connected to.
            // oxlint-disable-next-line frame-guard/no-unfiltered-frame-send -- a peer-connection message over the pairing transport, never a frame send
            await deps.transport.send(message, remoteHostPeerId() ?? undefined);
        } catch {
            // The host left between the connected check and the send.
            if (pendingStart?.requestId === requestId) pendingStart = null;
            notConnected();
        }
    };

    const unsubscribeMessage = deps.transport.onMessage((peerId, raw) => {
        const message = parsePeerMessage(raw);
        // Only the desktop's own state: a fellow phone in the pairing room must not forge it.
        if (message === null || message.t !== 'autovote-state' || peerId !== remoteHostPeerId()) return;
        // A state still draining on the relay can arrive after a newer one that went over WebRTC: it must not replace
        // it. A new run (the desktop restarted) always applies and starts the count again.
        if (message.hostRun === appliedRun && message.n < appliedCount) return;
        appliedRun = message.hostRun;
        appliedCount = message.n;
        const previousCycles = state.cycles;
        // A Stop still waiting for the host keeps reading as requested over a state that does not answer it.
        if (
            pendingStop !== null &&
            (message.ack?.requestId === pendingStop.requestId || stoppedSince(message.state, pendingStop.epoch))
        ) {
            // The confirmed Stop supersedes a Run sent before it: that Run will not run, so it is no longer pending and a
            // fresh one is possible. A Run sent after the Stop keeps waiting for its own answer.
            if (pendingStart !== null && pendingStart.order < pendingStop.order) pendingStart = null;
            pendingStop = null;
        }
        // A Run / Resume is answered by its acknowledgment, or by a state that shows what came of it.
        if (
            pendingStart !== null &&
            (message.ack?.requestId === pendingStart.requestId ||
                message.state.executionMode !== 'stopped' ||
                message.state.startRefusal !== null)
        ) {
            pendingStart = null;
        }
        apply(
            pendingStop === null
                ? message.state
                : autovoteReducer(message.state, { type: ACTIONS.SET_STOP_RESULT, payload: REQUESTED }),
        );
        // A relayed state that shows a cycle the phone has not seen: the desktop ran one more
        // voting pass, so the phone's challenge list refetches through the caller's callback.
        if (message.state.cycles > previousCycles) deps.getOnChallengesRefresh()?.();
    });

    return {
        start: () => sendCommand('start'),
        stop: () => sendCommand('stop'),
        rearmSchedule: () => sendCommand('rearm'),
        getStartPending: () => pendingStart !== null,
        maybeResume: () => Promise.resolve(),
        dispose: () => {
            disposed = true;
            listeners.clear();
            unsubscribeMessage();
        },
        getState: () => state,
        subscribe: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
    } satisfies AutovoteController;
};
