/**
 * The userData JSON writers leave files owner-only. The mode passed to
 * writeFileSync only applies when a file is created, so these run against a
 * real temp dir to prove a pre-existing 0o644 file ends up 0o600 and a
 * freshly created directory is 0o700.
 */

jest.unmock('fs');
jest.unmock('node:fs');
jest.unmock('path');
jest.unmock('node:path');
jest.mock('../../src/js/runtime', () => ({
    __esModule: true,
    ...jest.requireActual<typeof import('../../src/js/runtime')>('../../src/js/runtime'),
}));

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type * as runtimeModule from '../../src/js/runtime';
import type * as storageModule from '../../src/js/settings/storage';

const runtime = require('../../src/js/runtime') as typeof runtimeModule;
const { storage, createJsonStore } = require('../../src/js/settings/storage') as typeof storageModule;

const modeOf = (p: string) => fs.statSync(p).mode & 0o777;

// chmod only toggles the read-only bit on Windows, so POSIX modes can't be asserted there.
const describePosix = process.platform === 'win32' ? describe.skip : describe;

describePosix('userData JSON writers leave files owner-only', () => {
    let root: string;
    let userData: string;

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'gs-storage-'));
        userData = path.join(root, 'userData');
        jest.spyOn(runtime, 'getAppUserDataPath').mockReturnValue(userData);
    });

    afterEach(() => {
        jest.restoreAllMocks();
        fs.rmSync(root, { recursive: true, force: true });
    });

    test('settings writeRaw tightens a pre-existing 0o644 file to 0o600', () => {
        fs.mkdirSync(userData);
        const file = path.join(userData, 'settings.json');
        fs.writeFileSync(file, '{}', { mode: 0o644 });
        fs.chmodSync(file, 0o644);
        expect(modeOf(file)).toBe(0o644);

        storage.writeRaw('{"token":"t"}');

        expect(modeOf(file)).toBe(0o600);
        expect(fs.readFileSync(file, 'utf8')).toBe('{"token":"t"}');
    });

    test('createJsonStore writeRaw tightens a pre-existing 0o644 file to 0o600', () => {
        fs.mkdirSync(userData);
        const file = path.join(userData, 'metadata.json');
        fs.writeFileSync(file, '{}', { mode: 0o644 });
        fs.chmodSync(file, 0o644);

        createJsonStore({ fileName: 'metadata.json', prefKey: 'k' }).writeRaw('{"a":1}');

        expect(modeOf(file)).toBe(0o600);
        expect(fs.readFileSync(file, 'utf8')).toBe('{"a":1}');
    });

    test('a directory created by a write is 0o700 and the new file 0o600', () => {
        storage.writeRaw('{}');

        expect(modeOf(userData)).toBe(0o700);
        expect(modeOf(path.join(userData, 'settings.json'))).toBe(0o600);
    });
});
