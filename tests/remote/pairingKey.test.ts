/** Current-v2 pairing URLs and direct-entry fragments accept one exact key only. */

import { isPairingKey, parsePairingLink, takePairingKey } from '../../src/ts/core/remote/pairingKey';
import {
    remoteConnectionState,
    setRemoteConnectionState,
    subscribeRemoteConnectionState,
} from '../../src/ts/core/remote/connectionState';

const KEY = 'AbC-_9'.repeat(7) + 'A';

describe('takePairingKey', () => {
    const g = globalThis as { location: { hash: string } };

    beforeEach(() => {
        g.location = { hash: '' };
    });

    test('takes one valid key from the fragment', () => {
        g.location.hash = `#k=${KEY}`;
        expect(takePairingKey()).toBe(KEY);
    });

    test.each(['', '#k=', '#k=bad', `#k=${KEY}&k=${KEY}`])('refuses %s without a fallback', (hash) => {
        g.location.hash = hash;
        expect(takePairingKey()).toBeNull();
    });
});

describe('the pairing link a phone pastes', () => {
    test('the key has the desktop key shape: 43 base64url characters, nothing else', () => {
        expect(KEY).toHaveLength(43);
        expect(isPairingKey(KEY)).toBe(true);
        expect(isPairingKey(KEY.slice(1))).toBe(false);
        expect(isPairingKey(`${KEY}A`)).toBe(false);
        expect(isPairingKey(`${KEY.slice(1)}=`)).toBe(false);
        expect(isPairingKey('')).toBe(false);
    });

    test.each([
        `https://example.test/remote/v2/#k=${KEY}`,
        `https://example.test/remote/v2/index.html#k=${KEY}`,
        `  http://192.168.1.5:8080/remote/v2/#k=${KEY}\n`,
    ])('accepts a canonical current-v2 pairing URL', (link) => {
        expect(parsePairingLink(link)).toBe(KEY);
    });

    test.each([
        'not a URL',
        `file:///remote/v2/#k=${KEY}`,
        `https://example.test/remote/#k=${KEY}`,
        `https://example.test/remote/v1/#k=${KEY}`,
        `https://example.test/remote/v3/#k=${KEY}`,
        `https://example.test/remote/v2#k=${KEY}`,
        `https://example.test/remote/v2/#k=bad`,
        `https://example.test/remote/v2/#k=${KEY}&k=${KEY}`,
        `https://example.test/remote/v2/#k=${KEY}&v=2`,
    ])('refuses a non-current or malformed pairing URL', (link) => {
        expect(parsePairingLink(link)).toBeNull();
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
