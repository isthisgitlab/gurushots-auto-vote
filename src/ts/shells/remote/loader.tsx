/**
 * Remote loader entry — the thin, stable document the pairing link opens (`/remote/`). It
 * joins the pairing room, reads the desktop's app version from its `hello`, and moves on to
 * the matching `/remote/<version>/index.html` page (the link's fragment is kept, so the key travels
 * with it). An older desktop always gets a matching phone page this way, and the pairing
 * link itself never changes.
 *
 * The notice screen shows from the first moment ("Connecting to your computer…"), not once the
 * room is joined. A version whose page the site no longer publishes says which side to update:
 * the app on the computer when the desktop is older than this page, this app when it is newer. A
 * room where no desktop answers says the computer is offline, or this link was reset. The
 * timeout must outlast a relay round trip on a slow mobile network — it is generous on purpose.
 *
 * The loader reads nothing from the platform port and imports no Node-side module, so its bundle
 * stays small.
 */

import { createTrysteroTransport, isConnectionFailureJoinError } from '../../core/remote/trystero';
import { setRemoteConnectionState } from '../../core/remote/connectionState';
import { HOST_ANSWER_TIMEOUT_MS, createHelloRepeater } from '../../core/remote/helloRepeat';
import { takePairingKey } from '../../core/remote/pairingKey';
import {
    PAGE_VERSION,
    PROTOCOL_VERSION,
    compareReleaseVersions,
    isReleaseVersion,
    parsePeerMessage,
} from '../../core/remote/protocol';
import { mountRemoteNotice } from '../../react/components/app/RemoteNoticeScreen';
import { installPhoneDisconnect } from './phoneMode';

import type { HelloMessage } from '../../core/remote/protocol';

/**
 * The version's page by file name: the Android app's local server answers a directory path with
 * its own document, so a versioned page is always addressed as its `index.html` (the Pages site
 * serves the same file).
 */
const versionPage = (version: string): string => `./${encodeURIComponent(version)}/index.html`;

/** Whether the site (or the APK) carries the version's page. */
const versionIsPublished = async (version: string): Promise<boolean> => {
    try {
        const probe = await fetch(versionPage(version), { method: 'HEAD' });
        return probe.ok;
    } catch {
        return true; // the probe itself could not run; let the versioned page speak for itself
    }
};

void (async () => {
    const key = takePairingKey();
    if (key === null) {
        setRemoteConnectionState('no-key');
        mountRemoteNotice();
        return;
    }
    // Inside the Android app's WebView the notice screens carry Disconnect too: the app opens
    // here on every launch until the user leaves remote mode. It is installed before the first render.
    installPhoneDisconnect();
    mountRemoteNotice();
    let done = false;
    const transport = await createTrysteroTransport({ key });
    // The loader only asks the desktop's version: `role: 'loader'` keeps it out of the desktop's phone count.
    const announce: HelloMessage = {
        t: 'hello',
        version: PAGE_VERSION,
        protocolVersion: PROTOCOL_VERSION,
        host: false,
        role: 'loader',
    };
    // The first hello can be lost on the relay path, so it repeats until the loader settles.
    const hello = createHelloRepeater({ transport, announce, active: () => !done });
    /** The peers seen and not yet gone: any of them may still be the desktop. */
    const waiting = new Set<string>();
    const settleNotice = (state: 'offline' | 'network'): void => {
        if (done) return;
        done = true;
        hello.stop();
        void transport.leave();
        setRemoteConnectionState(state);
    };
    const finishWith = (version: string): void => {
        if (done) return;
        done = true;
        hello.stop();
        void versionIsPublished(version).then((published) => {
            if (!published) {
                void transport.leave();
                // The desktop is newer than every page this site (or this app) carries: this side updates.
                setRemoteConnectionState(compareReleaseVersions(version, PAGE_VERSION) > 0 ? 'update-this' : 'update');
                return;
            }
            globalThis.location.replace(`${versionPage(version)}${globalThis.location.hash}`);
        });
    };
    transport.onPeerJoin((peerId) => {
        waiting.add(peerId);
        hello.join(peerId);
    });
    transport.onPeerLeave((peerId) => {
        waiting.delete(peerId);
        hello.leave(peerId);
    });
    transport.onMessage((_peerId, raw) => {
        const message = parsePeerMessage(raw);
        // A version that is not a release version is no desktop's answer: nothing builds a path from it.
        if (message === null || message.t !== 'hello' || !message.host || !isReleaseVersion(message.version)) return;
        finishWith(message.version);
    });
    // A desktop the relays found but WebRTC could not reach is the try-Wi-Fi case; every other
    // join failure (wrong password, handshake timeout) reads as offline-or-reset. A fellow phone's
    // failed connection says nothing about the desktop: the loader settles only when no peer is left.
    transport.onJoinError(({ error, peerId }) => {
        waiting.delete(peerId);
        hello.leave(peerId);
        if (waiting.size > 0) return;
        settleNotice(isConnectionFailureJoinError(error) ? 'network' : 'offline');
    });
    globalThis.setTimeout(() => settleNotice('offline'), HOST_ANSWER_TIMEOUT_MS);
})().catch(() => {
    setRemoteConnectionState('offline');
    mountRemoteNotice();
});
