/**
 * Remote entry (shells/remote/page.tsx) — with a pairing key it joins the
 * room, installs the peer bridge and mounts the app over the relayed
 * transport; without one it shows the QR notice and mounts nothing; a
 * transport that cannot be built leaves the offline state showing. The
 * end-to-end redirect test loads the real bridge, so the address-bar rewrite
 * composes with the loader redirect the bridge performs.
 */

import { TransportStub } from '../helpers/remoteTransport';
import { installPhoneRemoteMode } from '../../src/ts/core/remote/phoneMode';
import { PROTOCOL_VERSION } from '../../src/ts/core/remote/protocol';

import type { RendererGlobals } from '../../src/ts/core/types/capacitor';

const SRC = '../../src/ts';

const flush = async () => {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

describe('Remote entry', () => {
    let saved: boolean | undefined;

    beforeEach(() => {
        saved = (globalThis as RendererGlobals).__capacitorBootstrap;
        document.body.innerHTML = '<div id="root"></div>';
        window.location.hash = '#k=the-key';
        window.sessionStorage.clear();
    });

    afterEach(() => {
        if (saved === undefined) delete (globalThis as RendererGlobals).__capacitorBootstrap;
        else (globalThis as RendererGlobals).__capacitorBootstrap = saved;
        document.body.innerHTML = '';
        window.location.hash = '';
        window.sessionStorage.clear();
        window.localStorage.clear();
        // The end-to-end test loads the real bridge: it marks the platform kind and installs window.api.
        delete (globalThis as { api?: unknown }).api;
        delete (globalThis as { __autovotePlatformKind?: string }).__autovotePlatformKind;
    });

    const load = (transport: object | Error, android = false) => {
        const m = {
            transport: { marker: 'remote-transport' },
            installed: jest.fn(),
            installDisconnect: jest.fn(),
            mounted: [] as unknown[],
            created: [] as unknown[],
        };
        jest.doMock(`${SRC}/core/remote/trystero`, () => ({
            createTrysteroTransport: jest.fn(async (options: unknown) => {
                m.created.push(options);
                if (transport instanceof Error) throw transport;
                return m.transport;
            }),
        }));
        jest.doMock(`${SRC}/shells/remote/bridge/peer`, () => ({
            installPeerBridge: m.installed,
        }));
        jest.doMock(`${SRC}/shells/remote/phoneMode`, () => ({
            installPhoneDisconnect: () => {
                m.installDisconnect();
                if (android) {
                    // Inside the app the real install puts the Disconnect entry into the very
                    // phone-mode module this isolated page's imports bound to.
                    jest.requireActual<typeof import('../../src/ts/core/remote/phoneMode')>(
                        '../../src/ts/core/remote/phoneMode',
                    ).installPhoneRemoteMode({ disconnect: async () => undefined });
                }
            },
        }));
        jest.doMock(`${SRC}/react/pages/App`, () => ({
            mountApp: jest.fn((_host: unknown, remoteTransport?: unknown) => {
                m.mounted.push(remoteTransport);
                return null;
            }),
        }));
        jest.doMock(`${SRC}/react/contexts/noopBackgroundHost`, () => ({ noopBackgroundHost: { marker: 'noop' } }));
        jest.isolateModules(() => {
            require(`${SRC}/shells/remote/page`);
        });
        return m;
    };

    /** The real peer bridge: only the transport, the app mount and the background host stand in. */
    const loadWithRealBridge = (transport: TransportStub) => {
        const m = {
            transport,
            mounted: [] as unknown[],
        };
        // The `load` harness's mocks of these two are still registered; this loader needs the real ones.
        jest.dontMock(`${SRC}/shells/remote/bridge/peer`);
        jest.dontMock(`${SRC}/shells/remote/phoneMode`);
        jest.doMock(`${SRC}/core/remote/trystero`, () => ({
            createTrysteroTransport: jest.fn(async () => m.transport),
            isConnectionFailureJoinError: jest.requireActual<typeof import('../../src/ts/core/remote/trystero')>(
                '../../src/ts/core/remote/trystero',
            ).isConnectionFailureJoinError,
        }));
        jest.doMock(`${SRC}/react/pages/App`, () => ({
            mountApp: jest.fn((_host: unknown, remoteTransport?: unknown) => {
                m.mounted.push(remoteTransport);
                return null;
            }),
        }));
        jest.doMock(`${SRC}/react/contexts/noopBackgroundHost`, () => ({ noopBackgroundHost: { marker: 'noop' } }));
        jest.isolateModules(() => {
            require(`${SRC}/shells/remote/page`);
        });
        return m;
    };

    test('with a key it joins the room, installs the bridge and mounts the app over the transport', async () => {
        const m = load({ marker: 'remote-transport' });
        await flush();
        // The transport is built for the phone side of the pairing.
        expect(m.created).toEqual([{ key: expect.any(String), role: 'phone' }]);
        // The second argument is the loader target the bridge goes to on a version mismatch.
        expect(m.installed).toHaveBeenCalledWith(m.transport, expect.any(String));
        expect(m.mounted).toEqual([m.transport]);
        // The Android app's Disconnect is offered before the app mounts (it installs nothing in a browser tab).
        expect(m.installDisconnect).toHaveBeenCalledTimes(1);
        expect(m.installDisconnect.mock.invocationCallOrder[0]).toBeLessThan(m.installed.mock.invocationCallOrder[0]);
        // App.tsx's own auto-mount stayed deferred.
        expect((globalThis as RendererGlobals).__capacitorBootstrap).toBe(true);
    });

    test('inside the Android app the address bar keeps the versioned page (a reload there cannot reach the loader)', async () => {
        const replaceState = jest.spyOn(window.history, 'replaceState');
        try {
            installPhoneRemoteMode({ disconnect: async () => undefined });
            const m = load({ marker: 'remote-transport' }, true);
            await flush();
            expect(replaceState).not.toHaveBeenCalled();
            // The redirect still has a loader to go to.
            expect(m.installed).toHaveBeenCalledWith(m.transport, expect.any(String));
        } finally {
            replaceState.mockRestore();
            installPhoneRemoteMode({});
        }
    });

    test('the address bar keeps its versioned path and normalizes the pairing fragment', async () => {
        window.history.pushState(null, '', '/remote/v2/index.html#k=the-key');
        const replaceState = jest.spyOn(window.history, 'replaceState');
        try {
            const m = load({ marker: 'remote-transport' });
            await flush();
            expect(replaceState).toHaveBeenCalledWith(null, '', '#k=the-key');
            expect(window.location.pathname).toBe('/remote/v2/index.html');
            // Before anything connects or mounts: the very first thing a saved link sees is the stable one.
            expect(replaceState.mock.invocationCallOrder[0]).toBeLessThan(m.installed.mock.invocationCallOrder[0]);
        } finally {
            replaceState.mockRestore();
        }
    });

    test('a key kept only by the tab (a reload with no fragment) is restored in the page fragment', async () => {
        window.sessionStorage.setItem('remote-pairing-key', 'tab-key');
        window.location.hash = '';
        const replaceState = jest.spyOn(window.history, 'replaceState');
        try {
            load({ marker: 'remote-transport' });
            await flush();
            expect(replaceState).toHaveBeenCalledWith(null, '', '#k=tab-key');
        } finally {
            replaceState.mockRestore();
        }
    });

    test('without a key it shows the QR notice and mounts nothing', async () => {
        window.location.hash = '';
        const m = load({ marker: 'remote-transport' });
        await flush();
        expect(m.installed).not.toHaveBeenCalled();
        expect(m.installDisconnect).not.toHaveBeenCalled();
        expect(m.mounted).toEqual([]);
        expect(document.getElementById('root')?.textContent).toBe('app.remoteNoKey');
    });

    test('a document without the root element renders nothing and mounts nothing', async () => {
        document.body.innerHTML = '';
        window.location.hash = '';
        const m = load({ marker: 'remote-transport' });
        await flush();
        expect(m.installed).not.toHaveBeenCalled();
        expect(m.mounted).toEqual([]);
        expect(document.getElementById('root')).toBeNull();
    });

    test('a transport that cannot be built leaves the offline-or-reset state', async () => {
        const m = load(new Error('no webrtc'));
        await flush();
        expect(m.installed).not.toHaveBeenCalled();
        expect(m.mounted).toEqual([]);
        expect(document.getElementById('root')?.textContent).toBe('app.remoteOfflineDetail');
    });

    test('a link version mismatch reached from a versioned page goes to the loader beside it, not the site root', async () => {
        // The document keeps its versioned path while the loader target is resolved beside it.
        window.history.pushState(null, '', '/remote/v1/index.html#k=the-key');
        const transport = new TransportStub('phone');
        loadWithRealBridge(transport);
        await flush();
        const replaced: string[] = [];
        const replaceSpy = jest.spyOn(window.location, 'replace').mockImplementation((url: string | URL) => {
            replaced.push(String(url));
        });
        try {
            transport.emitJoin('host');
            await flush();
            transport.receiveFromPeer(
                { t: 'hello', version: '9.9.9', protocolVersion: PROTOCOL_VERSION, linkVersion: 1, host: true },
                'host',
            );
            await flush();
            // The page returns the desktop's checked link version to the root loader.
            for (let waited = 0; waited < 100 && replaced.length === 0; waited += 1) {
                await new Promise((resolve) => setTimeout(resolve, 10));
            }
            const target = replaced[0];
            expect(target).toBeDefined();
            expect(new URL(target ?? '', window.location.href).hash).toContain('v=1');
            expect(new URL(target ?? '', window.location.href).pathname.endsWith('/remote/index.html')).toBe(true);
        } finally {
            replaceSpy.mockRestore();
            window.history.replaceState(null, '', '/');
        }
    });
});
