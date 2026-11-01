/**
 * The /remote/ loader: with a key it joins the room, reads the desktop's
 * version from its hello, and moves on to that version's page (the fragment
 * kept); a version the site does not publish says to update; no answer at
 * all says the computer is offline; no key says to scan the QR code.
 */

import { TransportStub } from '../helpers/remoteTransport';

const transportStub: { current: TransportStub | Error | null } = { current: null };

jest.mock('../../src/ts/core/remote/trystero', () => ({
    // A non-Error stub joins; an Error makes the join fail (the entry's catch path).
    createTrysteroTransport: jest.fn(async () => {
        const current = transportStub.current;
        if (current instanceof Error) throw current;
        return current as TransportStub;
    }),
}));
jest.mock('../../src/ts/shells/remote/bridge/peer', () => ({ PAGE_VERSION: '9.9.9' }));
// The platform module installs on load; the Jest setup has one installed already.
jest.mock('../../src/ts/shells/remote/platform', () => ({}));
// The shared React setup mocks the page translator; the loader's notice screen shows real text.
jest.mock('../../src/ts/core/translations/renderer', () => ({
    rendererTranslator: jest.requireActual<typeof import('../../src/ts/core/translations/renderer')>(
        '../../src/ts/core/translations/renderer',
    ).rendererTranslator,
}));

const g = globalThis as { fetch?: unknown };
const assigned: string[] = [];
let fetchCalls: string[];
let assignSpy: jest.SpiedFunction<(url: string | URL) => void>;

const loadLoader = (): void => {
    jest.isolateModules(() => {
        require('../../src/ts/shells/remote/loader');
    });
};

const flush = async (): Promise<void> => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe('the /remote/ loader', () => {
    let headOk: boolean;

    beforeEach(() => {
        jest.useFakeTimers();
        assigned.length = 0;
        fetchCalls = [];
        transportStub.current = TransportStub.pair('host', 'loader')[1];
        // happy-dom owns window.location: set the hash on it and spy on the navigation.
        window.location.hash = '#k=the-key';
        assignSpy = jest.spyOn(window.location, 'assign').mockImplementation((url: string | URL) => {
            assigned.push(String(url));
        });
        g.fetch = jest.fn(async (input: unknown) => {
            fetchCalls.push(String(input));
            return { ok: headOk } as Response;
        }) as unknown as typeof fetch;
        headOk = true;
        document.body.innerHTML = '<div id="root"></div>';
    });

    afterEach(() => {
        jest.useRealTimers();
        assignSpy.mockRestore();
        delete g.fetch;
        window.sessionStorage.clear();
        window.location.hash = '';
    });

    test('a hello names the version and the loader moves to its page, fragment kept', async () => {
        loadLoader();
        await flush();
        const transport = transportStub.current as TransportStub;
        transport.emitJoin('host');
        await flush();
        // The loader announces itself to the peer it saw.
        const hello = transport.sent.find(({ message }) => (message as { t: string }).t === 'hello');
        expect(hello?.target).toBe('host');

        transport.receiveFromPeer({ t: 'hello', version: '1.2.3', host: true }, 'host');
        await flush();
        expect(fetchCalls).toEqual(['./1.2.3/']);
        expect(assigned).toEqual(['./1.2.3/#k=the-key']);
    });

    test('a version the site does not publish says to update', async () => {
        headOk = false;
        loadLoader();
        await flush();
        const transport = transportStub.current as TransportStub;
        transport.emitJoin('host');
        await flush();
        transport.receiveFromPeer({ t: 'hello', version: '0.9.0', host: true }, 'host');
        await flush();
        expect(assigned).toEqual([]);
        expect(transport.left).toBe(true);
        expect(document.getElementById('root')?.textContent).toContain('Update the app on your computer');
    });

    test('no desktop answering says the computer is offline, or this link was reset', async () => {
        loadLoader();
        await flush();
        await jest.advanceTimersByTimeAsync(15_000);
        expect(assigned).toEqual([]);
        expect((transportStub.current as TransportStub).left).toBe(true);
        expect(document.getElementById('root')?.textContent).toContain(
            'Your computer is offline, or this link was reset',
        );
    });

    test('a fellow phone hello does not pick the version', async () => {
        loadLoader();
        await flush();
        const transport = transportStub.current as TransportStub;
        transport.emitJoin('host');
        await flush();
        transport.receiveFromPeer({ t: 'hello', version: '0.0.1', host: false }, 'fellow-phone');
        await flush();
        expect(assigned).toEqual([]);
        expect(fetchCalls).toEqual([]);
    });

    test('no key in the link says to scan the QR code', async () => {
        window.location.hash = '';
        loadLoader();
        await flush();
        expect(assigned).toEqual([]);
        expect(document.getElementById('root')?.textContent).toContain('Scan the QR code on your computer to pair');
    });

    test('a second hello after the navigation started changes nothing', async () => {
        loadLoader();
        await flush();
        const transport = transportStub.current as TransportStub;
        transport.emitJoin('host');
        await flush();
        transport.receiveFromPeer({ t: 'hello', version: '1.2.3', host: true }, 'host');
        await flush();
        transport.receiveFromPeer({ t: 'hello', version: '9.9.9', host: true }, 'host');
        await flush();
        expect(assigned).toEqual(['./1.2.3/#k=the-key']);
    });

    test('a version probe that cannot run navigates anyway; a room that refuses us says offline', async () => {
        g.fetch = async () => {
            throw new Error('no network');
        };
        loadLoader();
        await flush();
        const transport = transportStub.current as TransportStub;
        transport.emitJoin('host');
        await flush();
        transport.receiveFromPeer({ t: 'hello', version: '1.2.3', host: true }, 'host');
        await flush();
        expect(assigned).toEqual(['./1.2.3/#k=the-key']);
    });

    test('a transport that cannot be built says the computer is offline', async () => {
        transportStub.current = new Error('no webrtc');
        loadLoader();
        await flush();
        expect(document.getElementById('root')?.textContent).toContain('offline, or this link was reset');
    });
});
