/**
 * The phone's pairing key storage: the fragment is the input and stays in the
 * address bar, the tab's sessionStorage is the only copy, and localStorage is
 * never touched.
 */

import {
    takePairingKey,
    PAIRING_KEY_STORAGE,
    ANDROID_PAIRING_KEY_PREF,
    isPairingKey,
    parsePairingLink,
} from '../../src/ts/core/remote/pairingKey';
import { REMOTE_PAGES_ORIGIN } from '../../src/ts/core/remote/relays';
import { LOCAL_DATA_STORES } from '../../src/ts/core/settings/localData';
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

describe('the pairing link a phone pastes', () => {
    const KEY = 'AbC-_9'.repeat(7) + 'A'; // 43 base64url characters

    test('the key has the desktop key shape: 43 base64url characters, nothing else', () => {
        expect(KEY).toHaveLength(43);
        expect(isPairingKey(KEY)).toBe(true);
        expect(isPairingKey(KEY.slice(1))).toBe(false);
        expect(isPairingKey(`${KEY}A`)).toBe(false);
        expect(isPairingKey(`${KEY.slice(1)}=`)).toBe(false);
        expect(isPairingKey('')).toBe(false);
    });

    test.each([
        `${REMOTE_PAGES_ORIGIN}/remote/#k=${KEY}`,
        `${REMOTE_PAGES_ORIGIN}/remote#k=${KEY}`,
        `${REMOTE_PAGES_ORIGIN}/remote/index.html#k=${KEY}`,
        `  http://192.168.1.5:8080/remote/#k=${KEY}\n`,
        `https://example.test/remote/#x=1&k=${KEY}`,
    ])('accepts unversioned loader URLs as v1 targets', (link) => {
        expect(parsePairingLink(link)).toEqual({ key: KEY, linkVersion: 1 });
    });

    test('accepts a canonical versioned page URL and retains its link version', () => {
        expect(parsePairingLink(`https://example.test/remote/v2/index.html#k=${KEY}`)).toEqual({
            key: KEY,
            linkVersion: 2,
        });
    });

    test.each([
        [`https://example.test/remote/v1#k=${KEY}`, 1],
        [`https://example.test/remote/v1/#k=${KEY}`, 1],
        [`https://example.test/remote/v1/index.html#k=${KEY}`, 1],
        [`https://example.test/remote/v999#k=${KEY}`, 999],
        [`https://example.test/remote/v999/#k=${KEY}`, 999],
        [`https://example.test/remote/v999/index.html#k=${KEY}`, 999],
        [`https://example.test/remote/#k=${KEY}&v=1`, 1],
        [`https://example.test/remote/index.html#k=${KEY}&v=999`, 999],
    ])('accepts canonical link-version boundaries for %s', (link, linkVersion) => {
        expect(parsePairingLink(link)).toEqual({ key: KEY, linkVersion });
    });

    test.each([
        ['not a URL', 'hello'],
        ['a non-web scheme', `javascript:alert(1)//remote/#k=${KEY}`],
        ['a file link', `file:///remote/#k=${KEY}`],
        ['another path of the site', `https://example.test/other/#k=${KEY}`],
        ['a path that only ends like the loader', `https://example.test/notremote/#k=${KEY}`],
        ['a deeper path below the loader', `https://example.test/remote/1.2.3/#k=${KEY}`],
        ['no fragment', 'https://example.test/remote/'],
        ['no k parameter', `https://example.test/remote/#key=${KEY}`],
        ['a short key', 'https://example.test/remote/#k=abc'],
        ['an empty key', 'https://example.test/remote/#k='],
        ['duplicate keys', `https://example.test/remote/#k=${KEY}&k=${KEY}`],
        ['duplicate link versions', `https://example.test/remote/#k=${KEY}&v=1&v=2`],
        ['a zero link version', `https://example.test/remote/#k=${KEY}&v=0`],
        ['a leading-zero link version', `https://example.test/remote/#k=${KEY}&v=01`],
        ['a four-digit link version', `https://example.test/remote/#k=${KEY}&v=1000`],
        ['a non-decimal link version', `https://example.test/remote/#k=${KEY}&v=1e0`],
        ['a version fragment on a versioned page', `https://example.test/remote/v2/#k=${KEY}&v=2`],
        ['a conflicting page and fragment version', `https://example.test/remote/v2/#k=${KEY}&v=1`],
        ['a zero directory version', `https://example.test/remote/v0/#k=${KEY}`],
        ['a leading-zero directory version', `https://example.test/remote/v01/#k=${KEY}`],
        ['a four-digit directory version', `https://example.test/remote/v1000/#k=${KEY}`],
        ['the key in the query', `https://example.test/remote/?k=${KEY}`],
    ])('refuses %s', (_name, link) => {
        expect(parsePairingLink(link)).toBeNull();
    });

    test('the Android Preferences key is the desktop pairing store key, and the wipe lists it', () => {
        expect(ANDROID_PAIRING_KEY_PREF).toBe('gs_remote_access');
        expect(LOCAL_DATA_STORES.map((store) => store.prefKey)).toContain(ANDROID_PAIRING_KEY_PREF);
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
