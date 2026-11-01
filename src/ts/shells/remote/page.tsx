/**
 * Remote entry — the phone page served from the Pages site's `/remote/<version>/` (and
 * bundled into the APK for the Android remote mode). Reads the pairing key from the link
 * fragment, joins the pairing room through the trystero transport, installs the peer bridge,
 * and mounts the same React app the desktop runs — over the relayed window.api, with no
 * local voting loop.
 *
 * The page installs no platform port: nothing the phone runs reads `platform()` (the settings,
 * the logs and the voting all live on the desktop), and leaving the Node platform family out keeps
 * the bundle off the vision stack.
 *
 * dist/remote.html loads the bundle this file produces. Without a key in the link the page
 * says to scan the QR code on the computer and mounts nothing else.
 */

// Tell App.tsx not to auto-mount when imported below; the remote page mounts it itself,
// after the bridge is installed (the web entry uses the same flag).
(globalThis as { __capacitorBootstrap?: boolean }).__capacitorBootstrap = true;

import { createTrysteroTransport } from '../../core/remote/trystero';
import { setRemoteConnectionState } from '../../core/remote/connectionState';
import { loaderAddressBarUrl, loaderNavigationUrl, takePairingKey } from '../../core/remote/pairingKey';
import { phoneRemoteMode } from '../../core/remote/phoneMode';
import { installPeerBridge } from './bridge/peer';
import { installPhoneDisconnect } from './phoneMode';
import { mountApp } from '../../react/pages/App';
import { mountRemoteNotice } from '../../react/components/app/RemoteNoticeScreen';
import { noopBackgroundHost } from '../../react/contexts/noopBackgroundHost';

import type { RendererGlobals } from '../../core/types/capacitor';

void (async () => {
    const key = takePairingKey();
    if (key === null) {
        setRemoteConnectionState('no-key');
        mountRemoteNotice();
        return;
    }
    // Resolve the loader target from the page's own address before the address bar moves:
    // after the replaceState, `../index.html` would resolve against the loader directory and
    // reach the site root instead of the loader.
    const loaderTarget = new URL(loaderNavigationUrl(key), globalThis.location.href).href;
    // Inside the Android app's WebView the page also installs its Disconnect,
    // so the Navbar can leave remote mode back to the app's normal mode.
    installPhoneDisconnect();
    // The address bar shows the stable loader address, not this version's: a bookmark or "Add to
    // Home Screen" then survives the next desktop update (the loader finds the matching page).
    // Inside the Android app the local server answers a directory path with the app's own
    // document, so a reload of the loader address would never reach the loader — the page keeps
    // its versioned address and only the redirect below moves the tab.
    if (phoneRemoteMode() === null) {
        globalThis.history.replaceState(null, '', loaderAddressBarUrl(key));
    }
    const transport = await createTrysteroTransport({ key });
    installPeerBridge(transport, loaderTarget);
    // The remote controller rides the same transport; AutovoteProvider builds it from the
    // platform kind the bridge just marked.
    mountApp(noopBackgroundHost, transport);
})().catch(() => {
    // A transport that cannot be built (no WebRTC, the room refused us) leaves the page on
    // the offline-or-reset message, which is the true state of a desktop it cannot reach.
    setRemoteConnectionState('offline');
    mountRemoteNotice();
});

// The flag's own type lives with the other renderer globals.
export type { RendererGlobals };
