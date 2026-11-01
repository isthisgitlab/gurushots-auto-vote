/**
 * The phone's hello, repeated until the desktop answers. The first hello can vanish on the relay
 * path (seen end to end: the host logs the peer, but no hello ever arrives), so every page that
 * waits on the desktop's hello — the loader and the peer bridge — announces to each peer it saw
 * at a fixed interval until its owner says the wait is over. One function, so the two never
 * drift apart.
 */

import type { HelloMessage } from './protocol';
import type { RemoteTransport } from './relays';

/** How often the phone re-announces itself until the desktop answers. */
export const HELLO_RETRY_MS = 3_000;

/**
 * How long a page waits for the desktop's hello before it reports the desktop absent. It must outlast
 * a relay round trip on a slow mobile network, so it is generous on purpose.
 */
export const HOST_ANSWER_TIMEOUT_MS = 15_000;

export type HelloRepeater = {
    /** A peer joined: announce to it now and, while the wait is on, again every HELLO_RETRY_MS. */
    join: (peerId: string) => void;
    /** A peer left: it is no longer announced to. */
    leave: (peerId: string) => void;
    /** Forgets every peer still waiting for an announce (the timer is left to `stop`). */
    clear: () => void;
    /** Stops the repeat; a later `join` starts it again if `active` still says the wait is on. */
    stop: () => void;
};

/**
 * `active` says whether the owner is still waiting for the desktop's hello; a join while it is
 * false announces once and starts no repeat.
 */
export const createHelloRepeater = (options: {
    transport: Pick<RemoteTransport, 'send'>;
    announce: HelloMessage;
    active: () => boolean;
}): HelloRepeater => {
    const { transport, announce, active } = options;
    /** The peers seen but not yet answered; the repeat targets them. */
    const unannounced = new Set<string>();
    let timer: ReturnType<typeof setInterval> | null = null;

    const announceTo = (peerId: string): void => {
        // oxlint-disable-next-line frame-guard/no-unfiltered-frame-send -- a peer-connection message over the pairing transport, never a frame send
        void transport.send(announce, peerId).catch(() => undefined);
    };

    const stop = (): void => {
        if (timer !== null) {
            globalThis.clearInterval(timer);
            timer = null;
        }
    };

    return {
        join: (peerId) => {
            unannounced.add(peerId);
            announceTo(peerId);
            if (timer !== null || !active()) return;
            timer = globalThis.setInterval(() => {
                for (const waiting of unannounced) announceTo(waiting);
            }, HELLO_RETRY_MS);
        },
        leave: (peerId) => {
            unannounced.delete(peerId);
        },
        clear: () => {
            unannounced.clear();
        },
        stop,
    };
};
