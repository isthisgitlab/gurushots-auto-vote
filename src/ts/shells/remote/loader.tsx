/**
 * Remote loader entry — the thin, stable document the pairing link opens (`/remote/`). It
 * joins the pairing room, reads the desktop's app version from its `hello`, and moves on to
 * the matching `/remote/<version>/index.html` page (the link's fragment is kept, so the key travels
 * with it). An older desktop always gets a matching phone page this way, and the pairing
 * link itself never changes.
 *
 * A version whose page the site no longer publishes (a desktop older than the oldest kept
 * copy) is told to update the app on the computer; a room where no desktop answers says the
 * computer is offline, or this link was reset. The timeout must outlast a relay round trip
 * on a slow mobile network — it is generous on purpose.
 */

import './platform';

import { createRoot } from 'react-dom/client';
import { createTrysteroTransport, isConnectionFailureJoinError } from '../../core/remote/trystero';
import { setRemoteConnectionState } from '../../core/remote/connectionState';
import { takePairingKey } from '../../core/remote/pairingKey';
import { parsePeerMessage, PROTOCOL_VERSION } from '../../core/remote/protocol';

import type { HelloMessage } from '../../core/remote/protocol';
import { RemoteNoticeScreen } from '../../react/components/app/RemoteNoticeScreen';
import { PAGE_VERSION } from './bridge/peer';
import { installPhoneDisconnect } from './phoneMode';

/** How long the loader waits for the desktop's hello before it reports the desktop absent. */
export const LOADER_TIMEOUT_MS = 15_000;

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

const renderNotice = (): void => {
    const root = document.getElementById('root');
    if (!root) return;
    root.replaceChildren();
    createRoot(root).render(<RemoteNoticeScreen />);
};

void (async () => {
    const key = takePairingKey();
    if (key === null) {
        setRemoteConnectionState('no-key');
        renderNotice();
        return;
    }
    // Inside the Android app's WebView the notice screens carry Disconnect too: the app opens
    // here on every launch until the user leaves remote mode.
    installPhoneDisconnect();
    let done = false;
    const transport = await createTrysteroTransport({ key });
    const settleNotice = (state: 'offline' | 'network'): void => {
        if (done) return;
        done = true;
        void transport.leave();
        setRemoteConnectionState(state);
        renderNotice();
    };
    const finishWith = (version: string): void => {
        if (done) return;
        done = true;
        void versionIsPublished(version).then((published) => {
            if (!published) {
                void transport.leave();
                setRemoteConnectionState('update');
                renderNotice();
                return;
            }
            globalThis.location.assign(`${versionPage(version)}${globalThis.location.hash}`);
        });
    };
    const announce: HelloMessage = {
        t: 'hello',
        version: PAGE_VERSION,
        protocolVersion: PROTOCOL_VERSION,
        host: false,
    };
    transport.onPeerJoin((peerId) => {
        // oxlint-disable-next-line frame-guard/no-unfiltered-frame-send -- the loader announces itself to the peer over the pairing transport, never a frame send
        void transport.send(announce, peerId).catch(() => undefined);
    });
    transport.onMessage((_peerId, raw) => {
        const message = parsePeerMessage(raw);
        if (message === null || message.t !== 'hello' || !message.host) return;
        finishWith(message.version);
    });
    // A desktop the relays found but WebRTC could not reach is the try-Wi-Fi case; every other
    // join failure (wrong password, handshake timeout) reads as offline-or-reset.
    transport.onJoinError(({ error }) => {
        settleNotice(isConnectionFailureJoinError(error) ? 'network' : 'offline');
    });
    globalThis.setTimeout(() => settleNotice('offline'), LOADER_TIMEOUT_MS);
})().catch(() => {
    setRemoteConnectionState('offline');
    renderNotice();
});
