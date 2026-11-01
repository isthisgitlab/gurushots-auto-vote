/**
 * The phone's pairing key storage: the fragment is the input and stays in the
 * address bar, the tab's sessionStorage is the only copy, and localStorage is
 * never touched.
 */

import { takePairingKey, PAIRING_KEY_STORAGE } from '../../src/ts/core/remote/pairingKey';
import {
    remoteConnectionState,
    setRemoteConnectionState,
    subscribeRemoteConnectionState,
} from '../../src/ts/core/remote/connectionState';

describe('takePairingKey', () => {
    const g = globalThis as { location: { hash: string }; sessionStorage?: Storage };
    let store: Map<string, string>;

    beforeEach(() => {
        store = new Map();
        g.location = { hash: '' };
        g.sessionStorage = {
            getItem: (key: string) => store.get(key) ?? null,
            setItem: (key: string, value: string) => {
                store.set(key, value);
            },
            removeItem: (key: string) => {
                store.delete(key);
            },
            clear: () => store.clear(),
            key: () => null,
            length: 0,
        } as Storage;
    });

    afterEach(() => {
        delete g.sessionStorage;
    });

    test('takes the key from the fragment and keeps it for the tab', () => {
        g.location.hash = '#k=abc123';
        expect(takePairingKey()).toBe('abc123');
        expect(store.get(PAIRING_KEY_STORAGE)).toBe('abc123');
        // The fragment is the caller's to keep in the address bar: nothing rewrites it here.
        expect(g.location.hash).toBe('#k=abc123');
    });

    test('a reload reads the kept copy when the fragment is gone', () => {
        g.location.hash = '#k=abc123';
        takePairingKey();
        g.location.hash = '';
        expect(takePairingKey()).toBe('abc123');
    });

    test('no key anywhere answers null', () => {
        expect(takePairingKey()).toBeNull();
    });

    test('an empty fragment parameter is no key', () => {
        g.location.hash = '#k=';
        expect(takePairingKey()).toBeNull();
    });

    test('a browser that refuses site data falls back to the fragment alone', () => {
        g.sessionStorage = undefined;
        g.location.hash = '#k=xyz';
        expect(takePairingKey()).toBe('xyz');
    });

    test('a sessionStorage that throws is read through, never at the cost of the key', () => {
        g.sessionStorage = {
            getItem: () => {
                throw new Error('blocked');
            },
            setItem: () => {
                throw new Error('blocked');
            },
            removeItem: () => undefined,
            clear: () => undefined,
            key: () => null,
            length: 0,
        } as Storage;
        g.location.hash = '#k=xyz';
        expect(takePairingKey()).toBe('xyz');
        // And the kept-copy read throws its way to null when there is no fragment either.
        g.location.hash = '';
        expect(takePairingKey()).toBeNull();
    });
});

describe('the connection-state store', () => {
    afterEach(() => setRemoteConnectionState('connecting'));

    test('the state changes and notifies, and repeats are silent', () => {
        expect(remoteConnectionState()).toBe('connecting');
        const seen: string[] = [];
        const unsubscribe = subscribeRemoteConnectionState((state) => seen.push(state));
        setRemoteConnectionState('connected');
        setRemoteConnectionState('connected');
        unsubscribe();
        setRemoteConnectionState('offline');
        expect(seen).toEqual(['connected']);
        expect(remoteConnectionState()).toBe('offline');
    });
});
