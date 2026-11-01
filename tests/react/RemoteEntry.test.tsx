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

jest.mock('../../src/ts/shells/remote/platform', () => ({}));

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
            PAGE_VERSION: '9.9.9',
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
        expect(m.installed).toHaveBeenCalledWith(m.transport);
        expect(m.mounted).toEqual([m.transport]);
        // App.tsx's own auto-mount stayed deferred.
        expect((globalThis as RendererGlobals).__capacitorBootstrap).toBe(true);
    });

    test('without a key it shows the QR notice and mounts nothing', async () => {
        window.location.hash = '';
        const m = load({ marker: 'remote-transport' });
        await flush();
        expect(m.installed).not.toHaveBeenCalled();
        expect(m.mounted).toEqual([]);
        expect(document.getElementById('root')?.textContent).toBe('app.remoteNoKey');
    });

    test('a transport that cannot be built leaves the offline-or-reset state', async () => {
        const m = load(new Error('no webrtc'));
        await flush();
        expect(m.installed).not.toHaveBeenCalled();
        expect(m.mounted).toEqual([]);
        expect(document.getElementById('root')?.textContent).toBe('app.remoteOfflineDetail');
    });
});
