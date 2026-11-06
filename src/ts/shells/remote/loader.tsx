/**
 * Remote loader entry — the thin, stable document the pairing link opens (`/remote/`). It
 * joins the pairing room, reads the desktop's link version from its `hello`, and moves on to
 * the matching `/remote/v<N>/index.html` page (the link's fragment is kept, so the key travels
 * with it). The pairing link itself never changes, and every desktop that speaks link version N gets
 * the one page, whatever app version it runs.
 *
 * The notice screen shows from the first moment ("Connecting to your computer…"), not once the
 * room is joined. A page the site does not publish says which side to update: the app on the
 * computer when the desktop is older than this page; when the desktop's link version is
 * newer, the Android app says to update this app and a browser tab says the page is not published yet. A
 * room where no desktop answers says the computer is offline, or this link was reset. The
 * timeout must outlast a relay round trip on a slow mobile network — it is generous on purpose.
 *
 * The loader reads nothing from the platform port and imports no Node-side module, so its bundle
 * stays small.
 */

import { createTrysteroTransport, isConnectionFailureJoinError } from '../../core/remote/trystero';
import { setRemoteConnectionState } from '../../core/remote/connectionState';
import { HOST_ANSWER_TIMEOUT_MS, createHelloRepeater } from '../../core/remote/helloRepeat';
import { watchPageLifecycle } from '../../core/remote/pageLifecycle';
import { takePairingKey } from '../../core/remote/pairingKey';
import {
    clearLinkVersion,
    markSkippedTo,
    skippedTo,
    storeLinkVersion,
    storedLinkVersion,
} from '../../core/remote/linkVersion';
import { APP_VERSION, LINK_VERSION, PROTOCOL_VERSION, parsePeerMessage } from '../../core/remote/protocol';
import { mountRemoteNotice } from '../../react/components/app/RemoteNoticeScreen';
import { phoneRemoteMode } from '../../core/remote/phoneMode';
import { installPhoneDisconnect } from './phoneMode';

import type { HelloMessage } from '../../core/remote/protocol';

/** A page's directory under `/remote/`: `v<N>`, built from a checked link version, so nothing a peer sends names another place. */
type PageDir = string;

const linkVersionDir = (linkVersion: number): PageDir => `v${linkVersion}`;

/**
 * The page by file name: the Android app's local server answers a directory path with
 * its own document, so a versioned page is always addressed as its `index.html` (the Pages site
 * serves the same file).
 */
const versionPage = (dir: PageDir): string => `./${encodeURIComponent(dir)}/index.html`;

/**
 * Whether the site (or the APK) carries the page. `whenProbeFails` is the answer when the probe itself could not
 * run: after a hello the versioned page speaks for itself (true); a return visit has not heard the desktop, so it does not skip (false).
 */
const pageIsPublished = async (dir: PageDir, whenProbeFails: boolean): Promise<boolean> => {
    try {
        const probe = await fetch(versionPage(dir), { method: 'HEAD' });
        return probe.ok;
    } catch {
        return whenProbeFails;
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
    // A return visit goes straight to the page of the link version it last reached: no transport, one HEAD request. A
    // version this tab already went straight to (its page sent the tab back, so the version was wrong or the page
    // could not tell), one whose page is not published, or a request that cannot run runs the whole flow below, which
    // says what is wrong (the network notice, if the network is why).
    const stored = await storedLinkVersion(key);
    if (stored !== null && skippedTo() !== stored && (await pageIsPublished(linkVersionDir(stored), false))) {
        markSkippedTo(stored);
        globalThis.location.replace(`${versionPage(linkVersionDir(stored))}${globalThis.location.hash}`);
        return;
    }
    if (stored !== null) clearLinkVersion();
    let done = false;
    const transport = await createTrysteroTransport({ key, role: 'phone' });
    // The loader only asks the desktop's version: `role: 'loader'` keeps it out of the desktop's phone count.
    const announce: HelloMessage = {
        t: 'hello',
        version: APP_VERSION,
        protocolVersion: PROTOCOL_VERSION,
        linkVersion: LINK_VERSION,
        host: false,
        role: 'loader',
    };
    // The first hello can be lost on the relay path, so it repeats until the loader settles.
    const hello = createHelloRepeater({ transport, announce, active: () => !done });
    const settleNotice = (state: 'offline' | 'network' | 'old-browser'): void => {
        if (done) return;
        done = true;
        hello.stop();
        void transport.leave();
        setRemoteConnectionState(state);
    };
    /** `linkVersion` is the desktop's link version, which names its page. */
    const finishWith = (dir: PageDir, linkVersion: number): void => {
        if (done) return;
        done = true;
        hello.stop();
        void pageIsPublished(dir, true).then(async (published) => {
            if (!published) {
                void transport.leave();
                const newerThanLoader = linkVersion > LINK_VERSION;
                // Inside the Android app the bundled page is simply older than the desktop: update this
                // app. In a browser the site just has not published that link version's page yet: try later.
                // A desktop whose page is gone (an older link version) is the one to update.
                setRemoteConnectionState(
                    newerThanLoader ? (phoneRemoteMode() === null ? 'unpublished' : 'update-this') : 'update',
                );
                return;
            }
            // Kept for the next visit, only for a page that is there; a write that fails is a shortcut lost, never
            // a stranded tab.
            await storeLinkVersion(linkVersion).catch(() => undefined);
            globalThis.location.replace(`${versionPage(dir)}${globalThis.location.hash}`);
        });
    };
    transport.onPeerJoin((peerId) => {
        hello.join(peerId);
    });
    transport.onPeerLeave((peerId) => {
        hello.leave(peerId);
    });
    /** The peers that announced themselves as fellow phones: their failures are not the desktop's. */
    const phones = new Set<string>();
    transport.onMessage((peerId, raw) => {
        const message = parsePeerMessage(raw);
        if (message === null || message.t !== 'hello') return;
        if (!message.host) {
            phones.add(peerId);
            return;
        }
        finishWith(linkVersionDir(message.linkVersion), message.linkVersion);
    });
    /** Whether a peer failed its connection on the SDP exchange before anyone answered — the timeout then reports the try-Wi-Fi case. */
    let connectionFailure = false;
    transport.onJoinError(({ error, peerId }) => {
        // A join error never settles the wait: a peer that failed its join was never a candidate, so
        // the desktop may still connect, and a fellow phone's failure must not settle it either — the
        // timeout speaks. The try-Wi-Fi mark is only for a peer that can still be the desktop.
        hello.leave(peerId);
        if (isConnectionFailureJoinError(error) && !phones.has(peerId)) connectionFailure = true;
    });
    // A page that goes away for good leaves the room, so the desktop does not wait on a ghost.
    watchPageLifecycle(transport);
    globalThis.setTimeout(() => {
        // Nobody answered. A browser that cannot run the relay fallback is told to update — it only has the
        // direct path, which is what most networks block. The loader's own wait ends before a join
        // error is forwarded (~35 s), so `network` is rarely reached here; the versioned page's bridge reads it.
        const relayRuns = transport.relayAvailable?.() ?? true;
        settleNotice(!relayRuns ? 'old-browser' : connectionFailure ? 'network' : 'offline');
    }, HOST_ANSWER_TIMEOUT_MS);
})().catch(() => {
    setRemoteConnectionState('offline');
    mountRemoteNotice();
});
