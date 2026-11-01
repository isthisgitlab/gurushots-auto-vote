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
    isConnectionFailureJoinError: (error: string): boolean =>
        error.startsWith('could not connect to peer') && error.includes('after exchanging SDP'),
}));
jest.mock('../../src/ts/shells/remote/bridge/peer', () => ({ PAGE_VERSION: '9.9.9' }));
const installPhoneDisconnect = jest.fn<void, []>();
jest.mock('../../src/ts/shells/remote/phoneMode', () => ({
    installPhoneDisconnect: () => installPhoneDisconnect(),
}));
import { PROTOCOL_VERSION } from '../../src/ts/core/remote/protocol';
import { HELLO_RETRY_MS } from '../../src/ts/core/remote/helloRepeat';
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

        transport.receiveFromPeer(
            { t: 'hello', version: '1.2.3', protocolVersion: PROTOCOL_VERSION, host: true },
            'host',
        );
        await flush();
        expect(fetchCalls).toEqual(['./1.2.3/index.html']);
        expect(assigned).toEqual(['./1.2.3/index.html#k=the-key']);
    });

    test("a version the site does not carry says to update (the probe names the page file, as the app's local server needs)", async () => {
        headOk = false;
        loadLoader();
        await flush();
        const transport = transportStub.current as TransportStub;
        transport.emitJoin('host');
        await flush();
        transport.receiveFromPeer(
            { t: 'hello', version: '0.9.0', protocolVersion: PROTOCOL_VERSION, host: true },
            'host',
        );
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
        transport.receiveFromPeer(
            { t: 'hello', version: '0.0.1', protocolVersion: PROTOCOL_VERSION, host: false },
            'fellow-phone',
        );
        await flush();
        expect(assigned).toEqual([]);
        expect(fetchCalls).toEqual([]);
    });

    test('a join failure after the SDP exchange says to try Wi-Fi', async () => {
        loadLoader();
        await flush();
        const transport = transportStub.current as TransportStub;
        transport.emitJoin('host');
        await flush();
        transport.emitJoinError(
            'could not connect to peer 3b6a after exchanging SDP; configure TURN servers with turnConfig or rtcConfig.iceServers',
        );
        await flush();
        expect(transport.left).toBe(true);
        expect(assigned).toEqual([]);
        expect(document.getElementById('root')?.textContent).toContain('try Wi-Fi');
        // The timeout racing a join error that already settled changes nothing.
        await jest.advanceTimersByTimeAsync(15_000);
        expect(document.getElementById('root')?.textContent).toContain('try Wi-Fi');
    });

    test('a dropped first hello is repeated, and the second one gets the answer', async () => {
        // The first announce vanishes on the relay path: the send is recorded and rejects quietly.
        const isolated = new TransportStub('loader');
        isolated.failNextSendOnce();
        transportStub.current = isolated;
        loadLoader();
        await flush();
        isolated.emitJoin('host');
        await flush();
        expect(isolated.sent).toHaveLength(1);

        // The loader repeats the hello; this one reaches the desktop, which answers.
        await jest.advanceTimersByTimeAsync(HELLO_RETRY_MS);
        expect(isolated.sent).toHaveLength(2);
        expect(isolated.sent.map(({ message }) => (message as { t: string }).t)).toEqual(['hello', 'hello']);
        isolated.receiveFromPeer(
            { t: 'hello', version: '9.9.9', protocolVersion: PROTOCOL_VERSION, host: true },
            'host',
        );
        await flush();

        // The loader redirects and never shows offline, and the repeat has stopped.
        expect(assigned).toEqual(['./9.9.9/index.html#k=the-key']);
        expect(document.getElementById('root')?.textContent).toBe('');
        await jest.advanceTimersByTimeAsync(HELLO_RETRY_MS * 3);
        expect(isolated.sent).toHaveLength(2);
        expect(isolated.left).toBe(false);
    });

    test('the hello repeats to a waiting peer only until the loader settles on offline', async () => {
        const transport = transportStub.current as TransportStub;
        loadLoader();
        await flush();
        transport.emitJoin('host');
        await flush();
        await jest.advanceTimersByTimeAsync(HELLO_RETRY_MS * 2);
        expect(transport.sent).toHaveLength(3);

        await jest.advanceTimersByTimeAsync(15_000);
        expect(document.getElementById('root')?.textContent).toContain('offline, or this link was reset');
        const afterSettle = transport.sent.length;
        await jest.advanceTimersByTimeAsync(HELLO_RETRY_MS * 3);
        expect(transport.sent).toHaveLength(afterSettle);
    });

    test('a peer that left is no longer announced to', async () => {
        const transport = transportStub.current as TransportStub;
        loadLoader();
        await flush();
        transport.emitJoin('gone');
        await flush();
        transport.emitLeave('gone');
        await jest.advanceTimersByTimeAsync(HELLO_RETRY_MS * 2);
        expect(transport.sent).toHaveLength(1);
    });

    test('another join failure reads as offline-or-reset', async () => {
        loadLoader();
        await flush();
        const transport = transportStub.current as TransportStub;
        transport.emitJoin('host');
        await flush();
        transport.emitJoinError('handshake timed out after 14000ms');
        await flush();
        expect(transport.left).toBe(true);
        expect(assigned).toEqual([]);
        expect(document.getElementById('root')?.textContent).toContain('offline, or this link was reset');
    });

    test("the Android app's Disconnect is installed once there is a key, before the connection is tried", async () => {
        installPhoneDisconnect.mockClear();
        loadLoader();
        await flush();
        expect(installPhoneDisconnect).toHaveBeenCalledTimes(1);
    });

    test('no key in the link says to scan the QR code', async () => {
        window.location.hash = '';
        installPhoneDisconnect.mockClear();
        loadLoader();
        await flush();
        expect(installPhoneDisconnect).not.toHaveBeenCalled();
        expect(assigned).toEqual([]);
        expect(document.getElementById('root')?.textContent).toContain('Scan the QR code on your computer to pair');
    });

    test('a document without the root element renders nothing', async () => {
        document.body.innerHTML = '';
        window.location.hash = '';
        loadLoader();
        await flush();
        expect(document.getElementById('root')).toBeNull();
    });

    test('a second hello after the navigation started changes nothing', async () => {
        loadLoader();
        await flush();
        const transport = transportStub.current as TransportStub;
        transport.emitJoin('host');
        await flush();
        transport.receiveFromPeer(
            { t: 'hello', version: '1.2.3', protocolVersion: PROTOCOL_VERSION, host: true },
            'host',
        );
        await flush();
        transport.receiveFromPeer(
            { t: 'hello', version: '9.9.9', protocolVersion: PROTOCOL_VERSION, host: true },
            'host',
        );
        await flush();
        expect(assigned).toEqual(['./1.2.3/index.html#k=the-key']);
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
        transport.receiveFromPeer(
            { t: 'hello', version: '1.2.3', protocolVersion: PROTOCOL_VERSION, host: true },
            'host',
        );
        await flush();
        expect(assigned).toEqual(['./1.2.3/index.html#k=the-key']);
    });

    test('a transport that cannot be built says the computer is offline', async () => {
        transportStub.current = new Error('no webrtc');
        loadLoader();
        await flush();
        expect(document.getElementById('root')?.textContent).toContain('offline, or this link was reset');
    });
});
