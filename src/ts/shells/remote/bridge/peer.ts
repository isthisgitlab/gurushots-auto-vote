/**
 * Remote peer bridge — populates window.api in the phone's browser tab over the pairing
 * connection, generated from the channel manifest like bridge/web.ts:
 *
 *   - invoke methods send an `invoke` message to the desktop host and settle when its
 *     `result` arrives; the desktop enforces the remote allowlist;
 *   - open-external-url / reload-window / refresh-menu act in the phone (like
 *     BROWSER_CHANNELS in bridge/web.ts — the desktop window is not the phone's), and the
 *     log calls are answered here and never sent to the desktop;
 *   - event methods subscribe to a local pub/sub fed by the host's `event` messages;
 *   - the connection state (connecting / connected / offline / try Wi-Fi / update) is
 *     exposed for the page's header badge.
 *
 * The desktop host is told from a fellow phone by its `hello`: only the host's hello carries
 * `host: true`. Results, events and a leave count only from that peer, and a fellow phone's
 * leave or join failure never ends the session. When the connection is lost, in-flight invokes are settled once — a spend
 * channel answers "unclear — check before retrying" (the `postOnce` rule: the desktop may
 * have run it), every other channel reports a failure — and the pending set is emptied, so
 * nothing is ever replayed after a reconnect.
 *
 * The work is split across the sibling modules of this directory: context.ts holds the shared
 * mutable state, invokes.ts the invoke pipeline, messages.ts the protocol switch, connection.ts
 * the peer state machine, and apiSurface.ts the window.api generation — this file composes them.
 *
 * Loaded only by the remote renderer entries, so they stay free of Node-side modules.
 */

import { markPlatformKind } from '../../../core/platform/kind';
import { APP_VERSION, LINK_VERSION, PROTOCOL_VERSION } from '../../../core/remote/protocol';
import { createHelloRepeater } from '../../../core/remote/helloRepeat';
import { watchPageLifecycle } from '../../../core/remote/pageLifecycle';

import type { HelloMessage } from '../../../core/remote/protocol';
import type { RemoteTransport } from '../../../core/remote/relays';

import { createPeerBridgeContext } from './context';
import { createInvokePipeline } from './invokes';
import { watchConnection } from './connection';
import { watchPeerMessages } from './messages';
import { installApiSurface, LOCAL_CHANNELS } from './apiSurface';
import { createViewPrefs } from './viewPrefs';

export { LOCAL_CHANNELS };

/**
 * Installs the bridge: marks the platform kind (synchronously, before anything mounts),
 * generates the window.api surface, and drives the connection state machine (the state lives
 * in core/remote/connectionState.ts, where the page's React reads it). `loaderTarget` is the
 * absolute loader address the page resolved from its own location — the one place a link version
 * mismatch sends the tab to.
 */
const installPeerBridge = (transport: RemoteTransport, loaderTarget: string): void => {
    markPlatformKind('remote');

    const ctx = createPeerBridgeContext(transport);

    // The phone's hello: its own app version, the legacy protocol shape version, its link version, not the host. It repeats
    // until the desktop answers (core/remote/helloRepeat.ts: the first one can vanish on the relays).
    const announce: HelloMessage = {
        t: 'hello',
        version: APP_VERSION,
        protocolVersion: PROTOCOL_VERSION,
        linkVersion: LINK_VERSION,
        host: false,
    };
    const hello = createHelloRepeater({ transport, announce, active: () => ctx.hostPeerId === null });

    const pipeline = createInvokePipeline(ctx);
    // One view-prefs store per install: the routed window.api calls, the desktop's settings-changed
    // events and the local events a phone write dispatches must reach the same instance.
    const viewPrefs = createViewPrefs({ ctx, sendInvoke: pipeline.sendInvoke });
    const { settlePendingForLostConnection, reconnect } = watchConnection({ ctx, hello, pipeline });
    watchPeerMessages({ ctx, hello, pipeline, viewPrefs, settlePendingForLostConnection, reconnect, loaderTarget });
    // The desktop may have forgotten this phone while the page was frozen in the back/forward cache: one hello.
    watchPageLifecycle(transport, () => {
        if (ctx.hostPeerId !== null) hello.announceOnce(ctx.hostPeerId);
    });
    installApiSurface(ctx, pipeline.sendInvoke, viewPrefs);
};

export { installPeerBridge };
