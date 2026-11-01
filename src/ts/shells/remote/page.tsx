/**
 * Remote entry — the phone page served from the Pages site's `/remote/<version>/` (and
 * bundled into the APK for the Android remote mode). Installs the node-family platform
 * (first import), reads the pairing key from the link fragment, joins the pairing room
 * through the trystero transport, installs the peer bridge, and mounts the same React app
 * the desktop runs — over the relayed window.api, with no local voting loop.
 *
 * dist/remote.html loads the bundle this file produces. Without a key in the link the page
 * says to scan the QR code on the computer and mounts nothing else.
 */

// Tell App.tsx not to auto-mount when imported below; the remote page mounts it itself,
// after the bridge is installed (the web entry uses the same flag).
import './platform';

(globalThis as { __capacitorBootstrap?: boolean }).__capacitorBootstrap = true;

import { createRoot } from 'react-dom/client';
import { createTrysteroTransport } from '../../core/remote/trystero';
import { setRemoteConnectionState } from '../../core/remote/connectionState';
import { takePairingKey } from '../../core/remote/pairingKey';
import { installPeerBridge } from './bridge/peer';
import { mountApp } from '../../react/pages/App';
import { RemoteNoticeScreen } from '../../react/components/app/RemoteNoticeScreen';
import { noopBackgroundHost } from '../../react/contexts/noopBackgroundHost';

import type { RendererGlobals } from '../../core/types/capacitor';

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
    const transport = await createTrysteroTransport({ key });
    installPeerBridge(transport);
    // The remote controller rides the same transport; AutovoteProvider builds it from the
    // platform kind the bridge just marked.
    mountApp(noopBackgroundHost, transport);
})().catch(() => {
    // A transport that cannot be built (no WebRTC, the room refused us) leaves the page on
    // the offline-or-reset message, which is the true state of a desktop it cannot reach.
    setRemoteConnectionState('offline');
    renderNotice();
});

// The flag's own type lives with the other renderer globals.
export type { RendererGlobals };
