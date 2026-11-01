/**
 * The phone's autovote controller: the same `AutovoteController` surface the desktop
 * controller exposes, but with no timer of its own. Its state arrives relayed from the
 * desktop host (`autovote-state` messages); start/stop/rearm go to the desktop as
 * `autovote-command` messages; `maybeResume` does nothing, because there is nothing local to
 * resume — the desktop holds the one voting timer, so a phone can never start a second one.
 *
 * Built by `AutovoteProvider` when the platform kind is `remote`, never
 * `createAutovoteController` — the remote shell has no window.api-backed voting loop.
 */

import { ACTIONS, autovoteReducer, initialState } from './state';
import { remoteConnectionState, remoteHostPeerId } from '../remote/connectionState';
import { parsePeerMessage } from '../remote/protocol';
import { rendererTranslator } from '../translations/renderer';

import type { RemoteTransport } from '../remote/relays';
import type { AutovoteState } from './state';
import type { AutovoteController } from './types';

export type RemoteAutovoteDeps = {
    /** The shared peer transport (the same one the peer bridge uses). */
    transport: RemoteTransport;
    /** Read on each relayed cycle change, so the caller's latest identity is the one called. */
    getOnChallengesRefresh: () => (() => unknown) | undefined;
};

export const createRemoteAutovoteController = (deps: RemoteAutovoteDeps): AutovoteController => {
    let state: AutovoteState = initialState;
    const listeners = new Set<() => void>();
    let disposed = false;

    const apply = (next: AutovoteState): void => {
        state = next;
        for (const listener of listeners) listener();
    };

    const sendCommand = async (command: 'start' | 'stop' | 'rearm'): Promise<void> => {
        if (disposed) return;
        if (remoteConnectionState() !== 'connected') {
            // The command would reach nobody. Say so on the status instead of resolving as if it ran.
            apply(
                autovoteReducer(state, {
                    type: ACTIONS.SET_ERROR,
                    payload: rendererTranslator.t('errors.remoteNotConnected'),
                }),
            );
            return;
        }
        // oxlint-disable-next-line frame-guard/no-unfiltered-frame-send -- a peer-connection message over the pairing transport, never a frame send
        await deps.transport.send({ t: 'autovote-command', command });
    };

    const unsubscribeMessage = deps.transport.onMessage((peerId, raw) => {
        const message = parsePeerMessage(raw);
        // Only the desktop's own state: a fellow phone in the pairing room must not forge it.
        if (message === null || message.t !== 'autovote-state' || peerId !== remoteHostPeerId()) return;
        const previousCycles = state.cycles;
        apply(message.state);
        // A relayed state that shows a cycle the phone has not seen: the desktop ran one more
        // voting pass, so the phone's challenge list refetches through the caller's callback.
        if (message.state.cycles > previousCycles) deps.getOnChallengesRefresh()?.();
    });

    return {
        start: () => sendCommand('start'),
        stop: () => sendCommand('stop'),
        rearmSchedule: () => sendCommand('rearm'),
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
