/**
 * The desktop's pairing store: the key is 32 random bytes in base64url, made
 * once and kept in `remote-access.json`, the link points at the Pages origin
 * (or the dev-only launcher argument's local build), and the QR code is a
 * `data:image/svg+xml` URL. The key is never logged.
 */

// tests/setup.ts mocks fs and path globally; the store's file is real here, for the test and
// for the platform's atomic-write transport alike.
jest.unmock('path');
jest.unmock('node:path');
jest.mock('node:fs', () => {
    const actual = jest.requireActual<typeof import('node:fs')>('node:fs');
    return { __esModule: true, ...actual, default: actual };
});
const fs = jest.requireActual<typeof import('node:fs')>('node:fs');
const os = jest.requireActual<typeof import('node:os')>('node:os');
const path = jest.requireActual<typeof import('node:path')>('node:path');
import { buildNodeTestPlatform, clearInstalledPlatform } from '../helpers/platform';

import type * as pairingModule from '../../src/ts/shells/electron/remote/pairing';

const loadPairing = (): {
    pairing: typeof pairingModule;
    jsonStore: typeof import('../../src/ts/core/settings/jsonStore');
} => {
    let loaded: typeof pairingModule;
    let jsonStore: typeof import('../../src/ts/core/settings/jsonStore');
    jest.isolateModules(() => {
        loaded = require('../../src/ts/shells/electron/remote/pairing') as typeof pairingModule;
        jsonStore =
            require('../../src/ts/core/settings/jsonStore') as typeof import('../../src/ts/core/settings/jsonStore');
    });
    return { pairing: loaded!, jsonStore: jsonStore! };
};

const installOver = (userData: string): void => {
    const base = buildNodeTestPlatform();
    const installed = Object.assign(base, { paths: { ...base.paths, userData: () => userData } });
    const port = require('../../src/ts/core/platform/port') as typeof import('../../src/ts/core/platform/port');
    port.resetPlatformForTests();
    port.installPlatform(installed);
};

const newPairing = (userData: string, argv: readonly string[] = []) => {
    installOver(userData);
    const warns: string[] = [];
    const { pairing, jsonStore } = loadPairing();
    const store = pairing.createRemotePairing({
        isPackaged: () => false,
        argv,
        warn: (message) => warns.push(message),
    });
    return { pairing: store, jsonStore, warns };
};

describe('the desktop pairing store', () => {
    let userData: string;

    beforeEach(() => {
        userData = fs.mkdtempSync(path.join(os.tmpdir(), 'gs-pairing-'));
    });

    afterEach(() => {
        clearInstalledPlatform();
        fs.rmSync(userData, { recursive: true, force: true });
    });

    test('the key is 32 random bytes in base64url, made once and kept', () => {
        const { pairing } = newPairing(userData);
        const first = pairing.state();
        expect(first.enabled).toBe(false);
        expect(first.key).toMatch(/^[A-Za-z0-9_-]{43}$/);

        // The same key again, and after enabling: it is permanent.
        expect(pairing.state().key).toBe(first.key);
        pairing.setEnabled(true);
        expect(pairing.state()).toEqual({ enabled: true, key: first.key });

        // It is the file's only content; it is not in config.json.
        const stored: unknown = JSON.parse(fs.readFileSync(path.join(userData, 'remote-access.json'), 'utf8'));
        expect(stored).toEqual({ enabled: true, key: first.key });
        expect(fs.existsSync(path.join(userData, 'config.json'))).toBe(false);
    });

    test('resetKey replaces the key and keeps the enabled flag', () => {
        const { pairing } = newPairing(userData);
        const first = pairing.state().key;
        pairing.setEnabled(true);
        const second = pairing.resetKey();
        expect(second).not.toBe(first);
        expect(second).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(pairing.state()).toEqual({ enabled: true, key: second });
    });

    test('the link points at the Pages origin, and the QR is an SVG data URL that carries it', () => {
        const { pairing } = newPairing(userData);
        const info = pairing.accessInfo();
        expect(info.enabled).toBe(false);
        expect(info.link).toBe(`https://isthisgitlab.github.io/gurushots-auto-vote/remote/#k=${pairing.state().key}`);
        expect(info.qrDataUrl).toMatch(/^data:image\/svg\+xml;base64,/);
        const svg = Buffer.from(info.qrDataUrl.slice('data:image/svg+xml;base64,'.length), 'base64').toString('utf8');
        expect(svg).toContain('<svg');
        // The QR encodes the link (the key rides it), but the SVG carries no plain-text key.
        expect(svg).not.toContain(info.link);
    });

    test('the dev-only launcher argument points the link at a local site build; a packaged build ignores it', () => {
        const dev = newPairing(userData, ['--remote-link-origin=http://127.0.0.1:8080']);
        expect(dev.pairing.accessInfo().link).toMatch(/^http:\/\/127\.0\.0\.1:8080\/remote\/#k=[A-Za-z0-9_-]{43}$/);
        expect(dev.warns).toEqual([]);

        const packagedWarns: string[] = [];
        const packaged = loadPairing().pairing.createRemotePairing({
            isPackaged: () => true,
            argv: ['--remote-link-origin=http://127.0.0.1:8080'],
            warn: (message) => packagedWarns.push(message),
        });
        expect(packaged.accessInfo().link).toMatch(
            /^https:\/\/isthisgitlab\.github\.io\/gurushots-auto-vote\/remote\/#k=[A-Za-z0-9_-]{43}$/,
        );
        expect(packagedWarns).toHaveLength(1);
    });

    test.each(['http://localhost:8080', 'http://127.0.0.1:3000', 'http://localhost:1'])(
        'the dev launcher argument accepts the local origin %s',
        (origin) => {
            const { pairing, warns } = newPairing(userData, [`--remote-link-origin=${origin}`]);
            expect(pairing.accessInfo().link).toBe(`${origin}/remote/#k=${pairing.state().key}`);
            expect(warns).toEqual([]);
        },
    );

    test.each([
        'https://evil.example',
        'http://evil.example:8080',
        'https://localhost:8080',
        'http://localhost',
        'http://localhost:8080/',
        'http://localhost:8080/path',
        'http://localhost:8080@evil.example',
        'http://localhost.evil.example:8080',
        'http://[::1]:8080',
        'http://localhost:123456',
        'javascript:alert(1)',
    ])('the dev launcher argument refuses %s, says so, and the link keeps the published pages', (origin) => {
        const { pairing, warns } = newPairing(userData, [`--remote-link-origin=${origin}`]);
        expect(pairing.accessInfo().link).toMatch(
            /^https:\/\/isthisgitlab\.github\.io\/gurushots-auto-vote\/remote\/#k=[A-Za-z0-9_-]{43}$/,
        );
        expect(warns).toEqual([expect.stringContaining('only http://localhost:<port> or http://127.0.0.1:<port>')]);
    });

    test('a damaged store file starts over with a fresh key, not a throw, and says so first', () => {
        fs.writeFileSync(path.join(userData, 'remote-access.json'), '{broken');
        const { pairing, warns } = newPairing(userData);
        expect(pairing.state().key).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(warns).toEqual([expect.stringContaining('remote-access.json could not be read')]);
        // The new key is stored: a second read is a plain read, with nothing more to say.
        pairing.state();
        expect(warns).toHaveLength(1);
        // And the warning never carries a key.
        expect(warns.join(' ')).not.toContain(pairing.state().key);
    });

    test('a stored file of the wrong shape is warned about before setEnabled replaces it', () => {
        fs.writeFileSync(path.join(userData, 'remote-access.json'), '{"enabled": true}');
        const { pairing, warns } = newPairing(userData);
        expect(pairing.setEnabled(true)).toBe(true);
        expect(warns).toEqual([expect.stringContaining('remote-access.json could not be read')]);
    });

    test('a missing store file is first use: nothing to warn about', () => {
        const { pairing, warns } = newPairing(userData);
        pairing.state();
        pairing.setEnabled(true);
        expect(warns).toEqual([]);
    });

    test('a stored file of the wrong shape is read as absent, and an empty dev origin is no origin', () => {
        fs.writeFileSync(path.join(userData, 'remote-access.json'), '{"nope": 1}');
        const { pairing } = newPairing(userData, ['--remote-link-origin=']);
        expect(pairing.state().enabled).toBe(false);
        expect(pairing.state().key).toMatch(/^[A-Za-z0-9_-]{43}$/);
        // The empty origin is ignored: the link points at the published pages.
        expect(pairing.accessInfo().link).toMatch(
            /^https:\/\/isthisgitlab\.github\.io\/gurushots-auto-vote\/remote\/#k=[A-Za-z0-9_-]{43}$/,
        );
        // And a write over the wrong shape keeps the state it makes.
        expect(pairing.setEnabled(true)).toBe(true);
        expect(pairing.state().enabled).toBe(true);
    });

    test('setEnabled as the very first call mints a key and turns the feature on', () => {
        // No read has run yet, so the update sees an empty store and mints the key itself.
        const { pairing } = newPairing(userData);
        expect(pairing.setEnabled(true)).toBe(true);
        expect(pairing.state()).toEqual({ enabled: true, key: pairing.state().key });
        expect(pairing.state().key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    });

    test('resetKey as the very first call keeps the feature off and mints the key', () => {
        // No read has run yet, so the reset sees an empty store: the enabled flag defaults off.
        const { pairing } = newPairing(userData);
        const key = pairing.resetKey();
        expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(pairing.state()).toEqual({ enabled: false, key });
    });

    test('resetKey answers null when the new key could not be saved, and the old key stays', () => {
        const { pairing, jsonStore } = newPairing(userData);
        const first = pairing.state().key;
        jsonStore.refuseWrites();
        expect(pairing.resetKey()).toBeNull();
        expect(pairing.state().key).toBe(first);
    });

    test('setEnabled answers false when the write did not land', () => {
        const { pairing, jsonStore } = newPairing(userData);
        jsonStore.refuseWrites();
        expect(pairing.setEnabled(true)).toBe(false);
    });
});
