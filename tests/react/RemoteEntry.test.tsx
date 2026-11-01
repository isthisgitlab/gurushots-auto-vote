/**
 * Remote entry (shells/remote/page.tsx) — with a pairing key it joins the
 * room, installs the peer bridge and mounts the app over the relayed
 * transport; without one it shows the QR notice and mounts nothing; a
 * transport that cannot be built leaves the offline state showing.
 */

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
    });

    const load = (transport: object | Error) => {
        const m = {
            transport: { marker: 'remote-transport' },
            installed: jest.fn(),
            installDisconnect: jest.fn(),
            mounted: [] as unknown[],
        };
        jest.doMock(`${SRC}/core/remote/trystero`, () => ({
            createTrysteroTransport: jest.fn(async () => {
                if (transport instanceof Error) throw transport;
                return m.transport;
            }),
        }));
        jest.doMock(`${SRC}/shells/remote/bridge/peer`, () => ({
            installPeerBridge: m.installed,
        }));
        jest.doMock(`${SRC}/shells/remote/phoneMode`, () => ({ installPhoneDisconnect: m.installDisconnect }));
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
        expect(m.installed).toHaveBeenCalledWith(m.transport);
        expect(m.mounted).toEqual([m.transport]);
        // The Android app's Disconnect is offered before the app mounts (it installs nothing in a browser tab).
        expect(m.installDisconnect).toHaveBeenCalledTimes(1);
        expect(m.installDisconnect.mock.invocationCallOrder[0]).toBeLessThan(m.installed.mock.invocationCallOrder[0]);
        // App.tsx's own auto-mount stayed deferred.
        expect((globalThis as RendererGlobals).__capacitorBootstrap).toBe(true);
    });

    test('the address bar shows the stable loader address, so a bookmark survives the next desktop update', async () => {
        const replaceState = jest.spyOn(window.history, 'replaceState');
        try {
            const m = load({ marker: 'remote-transport' });
            await flush();
            expect(replaceState).toHaveBeenCalledWith(null, '', '../#k=the-key');
            // Before anything connects or mounts: the very first thing a saved link sees is the stable one.
            expect(replaceState.mock.invocationCallOrder[0]).toBeLessThan(m.installed.mock.invocationCallOrder[0]);
        } finally {
            replaceState.mockRestore();
        }
    });

    test('a key kept only by the tab (a reload with no fragment) still puts the loader address in the bar', async () => {
        window.sessionStorage.setItem('remote-pairing-key', 'tab-key');
        window.location.hash = '';
        const replaceState = jest.spyOn(window.history, 'replaceState');
        try {
            load({ marker: 'remote-transport' });
            await flush();
            expect(replaceState).toHaveBeenCalledWith(null, '', '../#k=tab-key');
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
});
