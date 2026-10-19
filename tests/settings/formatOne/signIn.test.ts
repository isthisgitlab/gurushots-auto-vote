/**
 * What the mirror does about the sign-in, against a real temp directory: a sign-in an older build changed in
 * settings.json (a sign-out, another account) is taken over at the next start, and nothing else an older build did to
 * the file is; a logout takes the token and the API headers out of every copy set aside of a settings file; and the
 * settings.json the configuration could not be restored from is set aside before the first save mirrors over it, with
 * the same state however often it is read.
 */

jest.mock('node:fs', () => {
    const actual = jest.requireActual<typeof import('node:fs')>('node:fs');
    return { __esModule: true, ...actual, default: actual };
});
jest.unmock('path');
jest.unmock('node:path');
jest.mock('../../../src/ts/logger', () => {
    const cat = { info: jest.fn(), error: jest.fn(), debug: jest.fn(), success: jest.fn(), warning: jest.fn() };
    return {
        info: jest.fn(),
        warning: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
        isDevMode: jest.fn(() => false),
        isSourceCode: jest.fn(() => true),
        getAppName: jest.fn(() => 'gurushots-auto-vote-dev'),
        withCategory: jest.fn(() => cat),
        __cat: cat,
    };
});

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type * as runtimeModule from '../../../src/ts/runtime';
import type * as settingsModule from '../../../src/ts/settings';
import type * as loggerModule from '../../../src/ts/logger';
import type { CategoryLogger } from '../../../src/ts/logger';
import { isPlainObject } from '../../../src/ts/plainObject';
import { invalid } from '../../helpers/invalid';
import { parseJsonObject } from '../../helpers/parseJson';

type CatDouble = jest.Mocked<Pick<CategoryLogger, 'info' | 'error' | 'debug' | 'success' | 'warning'>>;

const TAKEN_BACK = 'The sign-in in settings.json was changed by an older build; it is kept';
const AUTH = {
    token: 'tok-1',
    apiHeaders: { 'x-a': 'b' },
    lastUsername: 'me@example.com',
    chosenPhotosMemberId: 'm-1',
};

describe('the sign-in in the mirror (real fs)', () => {
    let root: string;
    let userData: string;
    let configFile: string;
    let legacyFile: string;
    let markerFile: string;
    let settings: typeof settingsModule;
    let cat: CatDouble;

    // Every settings module loaded in a test: one with a window listening retries by itself, so each is told to stop.
    const loaded: Array<typeof settingsModule> = [];
    // Each test gets its own module graph; a "restart" is a new graph over the same directory.
    const loadFresh = (setup?: () => void) => {
        jest.isolateModules(() => {
            const actualRuntime = jest.requireActual<typeof runtimeModule>('../../../src/ts/runtime');
            jest.doMock('../../../src/ts/runtime', () => ({
                __esModule: true,
                ...actualRuntime,
                getAppUserDataPath: () => userData,
            }));
            setup?.();
            settings = require('../../../src/ts/settings') as typeof settingsModule;
            loaded.push(settings);
            cat = invalid<typeof loggerModule & { __cat: CatDouble }>(
                require('../../../src/ts/logger') as typeof loggerModule,
            ).__cat;
        });
    };
    const stored = (file: string) => parseJsonObject(fs.readFileSync(file, 'utf8'));
    // The inode of the file as opened, so the answer is about the file read and not a path looked up again.
    const inodeOf = (file: string) => {
        const fd = fs.openSync(file, 'r');
        try {
            return fs.fstatSync(fd).ino;
        } finally {
            fs.closeSync(fd);
        }
    };
    // The app has been used and signed in: the mirror has written, and the marker holds the sign-in it wrote.
    const signedIn = () => {
        loadFresh();
        for (const [key, value] of Object.entries(AUTH)) settings.setSetting(key, value);
        settings.setSetting('theme', 'dark');
    };
    // What an older build does: it changes the file it finds.
    const olderBuildChanges = (change: (file: Record<string, unknown>) => Record<string, unknown>) =>
        fs.writeFileSync(legacyFile, JSON.stringify(change(stored(legacyFile)), null, 2));
    const setAside = (suffix: string) => path.join(userData, suffix);
    // Makes the writes of files matching `pattern` fail, from the `skip`th on (the earlier ones go through), until `state.failing` is cleared.
    const failingWrites = (pattern: RegExp, skip = 0) => {
        const state = { failing: true, seen: 0 };
        // (Not `fs.openSync`, which is the spy itself when an earlier call set one up.)
        const real = jest.requireActual<typeof import('node:fs')>('node:fs').openSync;
        jest.spyOn(fs, 'openSync').mockImplementation(((file: fs.PathLike, ...rest: unknown[]) => {
            if (pattern.test(String(file)) && state.failing && state.seen++ >= skip) throw new Error('EROFS');
            return (real as (...args: unknown[]) => unknown)(file, ...rest);
        }) as typeof fs.openSync);
        return state;
    };
    const CONFIG_TMP = /config\.json\.\d+\.[0-9a-f]+\.tmp$/;
    const LEGACY_TMP = /settings\.json\.\d+\.[0-9a-f]+\.tmp$/;
    const MARKER_TMP = /v2-import\.json\.\d+\.[0-9a-f]+\.tmp$/;
    const everyLog = () => JSON.stringify([cat.info.mock.calls, cat.warning.mock.calls, cat.error.mock.calls]);

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'gs-signin-'));
        userData = path.join(root, 'userData');
        fs.mkdirSync(userData);
        configFile = path.join(userData, 'config.json');
        legacyFile = path.join(userData, 'settings.json');
        markerFile = path.join(userData, 'v2-import.json');
    });

    afterEach(() => {
        for (const mod of loaded.splice(0)) mod.onSettingsRecoveryChange(null);
        jest.restoreAllMocks();
        jest.dontMock('../../../src/ts/runtime');
        jest.dontMock('../../../src/ts/lockWait');
        jest.dontMock('../../../src/ts/settings/importV1');
        fs.rmSync(root, { recursive: true, force: true });
    });

    describe('the record that the copies still owe a clearing', () => {
        const marker = () =>
            require('../../../src/ts/settings/importMarker') as typeof import('../../../src/ts/settings/importMarker');

        test('is recorded anew by each sign-out (a missing marker is made for it), and forgotten only for the record that was seen', () => {
            loadFresh();
            // No marker: nothing to forget; a sign-out makes one, holding only its record.
            marker().clearSignOutScrubPending('x');
            expect(fs.existsSync(markerFile)).toBe(false);
            marker().markSignOutScrubPending();
            expect(stored(markerFile)).toEqual({ signOutScrubPending: expect.any(String) });
            fs.rmSync(markerFile);

            settings.setSetting('theme', 'dark');
            const untouched = fs.readFileSync(markerFile, 'utf8');
            marker().markSignOutScrubPending();
            const first = stored(markerFile).signOutScrubPending;
            expect(first).toEqual(expect.any(String));
            // A second sign-out is a record of its own.
            marker().markSignOutScrubPending();
            const second = stored(markerFile).signOutScrubPending;
            expect(second).toEqual(expect.any(String));
            expect(second).not.toBe(first);

            // Clearing the record that was seen first leaves the newer one owed.
            const written = inodeOf(markerFile);
            marker().clearSignOutScrubPending(String(first));
            expect(stored(markerFile).signOutScrubPending).toBe(second);
            // (Not even written again: the marker is read as stored here, so a record that is not the one seen is left alone.
            // The inode tells, as the marker is written atomically: a temp file renamed over it.)
            expect(inodeOf(markerFile)).toBe(written);
            marker().clearSignOutScrubPending(String(second));
            expect(fs.readFileSync(markerFile, 'utf8')).toBe(untouched);
        });
    });

    describe('a sign-in an older build changed in settings.json', () => {
        test('a sign-out stays: the token is cleared in the configuration, the mirror keeps it so, and the log holds no value', () => {
            signedIn();
            olderBuildChanges((file) => ({ ...file, theme: 'light', token: '', apiHeaders: {} }));

            loadFresh();
            const loaded = settings.loadSettings();

            expect(loaded.auth).toEqual({ ...AUTH, token: '', apiHeaders: {} });
            // Nothing but the sign-in is taken back: the theme is the configuration's, and is mirrored again.
            expect(loaded.app.theme).toBe('dark');
            expect(stored(legacyFile)).toMatchObject({ theme: 'dark', token: '', apiHeaders: {} });
            expect(stored(configFile).auth).toMatchObject({ token: '', apiHeaders: {} });
            expect(cat.info).toHaveBeenCalledWith(TAKEN_BACK);
            expect(everyLog()).not.toContain('tok-1');
            // It was taken once: the next start finds the mirror as it wrote it.
            cat.info.mockClear();
            loadFresh();
            expect(settings.loadSettings().auth.token).toBe('');
            expect(cat.info).not.toHaveBeenCalledWith(TAKEN_BACK);
        });

        test('another account is adopted, whole', () => {
            signedIn();
            olderBuildChanges((file) => ({
                ...file,
                token: 'tok-2',
                apiHeaders: { 'x-b': 'c' },
                lastUsername: 'other@example.com',
                chosenPhotosMemberId: 'm-2',
            }));

            loadFresh();

            expect(settings.loadSettings().auth).toEqual({
                token: 'tok-2',
                apiHeaders: { 'x-b': 'c' },
                lastUsername: 'other@example.com',
                chosenPhotosMemberId: 'm-2',
            });
            expect(stored(configFile).auth).toMatchObject({ token: 'tok-2', lastUsername: 'other@example.com' });
            expect(stored(legacyFile)).toMatchObject({ token: 'tok-2', chosenPhotosMemberId: 'm-2' });
        });

        test('a sign-in that did not change is not taken over: the configuration is not rewritten, whatever else changed', () => {
            signedIn();
            olderBuildChanges((file) => ({ ...file, theme: 'light', language: 'lv' }));
            const before = fs.readFileSync(configFile, 'utf8');

            loadFresh();
            const loaded = settings.loadSettings();

            expect(loaded.app).toMatchObject({ theme: 'dark' });
            expect(fs.readFileSync(configFile, 'utf8')).toBe(before);
            expect(cat.info).not.toHaveBeenCalledWith(TAKEN_BACK);
            expect(stored(legacyFile)).toMatchObject({ theme: 'dark', token: 'tok-1' });
        });

        test('a key the older build dropped was not decided there: the configuration keeps its own', () => {
            signedIn();
            // An older build prunes the keys it does not know (chosenPhotosMemberId) and writes the file back.
            olderBuildChanges(({ chosenPhotosMemberId: _dropped, ...file }) => file);

            loadFresh();

            expect(settings.loadSettings().auth).toEqual(AUTH);
            expect(cat.info).not.toHaveBeenCalledWith(TAKEN_BACK);
            expect(stored(legacyFile)).toMatchObject({ chosenPhotosMemberId: 'm-1' });
        });

        test.each([
            ['holds a token that is not text', { token: 5 }],
            ['holds headers that are not a map of text', { apiHeaders: ['x'] }],
        ])('a file that %s says nothing about that field', (_name, change) => {
            signedIn();
            olderBuildChanges((file) => ({ ...file, ...change }));

            loadFresh();

            expect(settings.loadSettings().auth).toEqual(AUTH);
            expect(cat.info).not.toHaveBeenCalledWith(TAKEN_BACK);
        });

        test.each([
            ['that does not parse', '{broken'],
            ['that is not an object', '[1]'],
        ])('a settings.json %s takes nothing over, and is mirrored again', (_name, text) => {
            signedIn();
            fs.writeFileSync(legacyFile, text);

            loadFresh();

            expect(settings.loadSettings().auth).toEqual(AUTH);
            expect(cat.info).not.toHaveBeenCalledWith(TAKEN_BACK);
            expect(stored(legacyFile)).toMatchObject({ token: 'tok-1' });
        });

        test('nothing is taken over where no fingerprint says what the mirror wrote (a marker from an earlier build)', () => {
            signedIn();
            fs.writeFileSync(
                markerFile,
                JSON.stringify({ ...stored(markerFile), signInPending: undefined, signInConfirmed: undefined }),
            );
            olderBuildChanges((file) => ({ ...file, token: '', apiHeaders: {} }));

            loadFresh();

            expect(settings.loadSettings().auth.token).toBe('tok-1');
            expect(stored(legacyFile)).toMatchObject({ token: 'tok-1' });
            // The mirror records it, so the next start can tell.
            expect(stored(markerFile)).toMatchObject({ signInConfirmed: expect.any(String) });
        });

        test('the marker keeps a fingerprint of the sign-in that landed (a hash of each field), cleared of its pending record, never the sign-in', () => {
            signedIn();

            const marker = fs.readFileSync(markerFile, 'utf8');

            expect(stored(markerFile).signInConfirmed).toEqual(expect.stringMatching(/^[0-9a-f]+(\.[0-9a-f]+){3}$/));
            // (The one recorded before the write is cleared once it is the one confirmed.)
            expect(stored(markerFile)).not.toHaveProperty('signInPending');
            expect(marker).not.toContain('tok-1');
            expect(marker).not.toContain('me@example.com');
        });

        test('is told apart by the headers whatever order they are written in', () => {
            signedIn();
            olderBuildChanges((file) => ({ ...file, apiHeaders: { 'x-a': 'b' }, theme: 'light' }));
            settings.setSetting('apiHeaders', { 'x-z': '1', 'x-a': 'b' });
            olderBuildChanges((file) => ({ ...file, apiHeaders: { 'x-a': 'b', 'x-z': '1' } }));

            loadFresh();

            expect(settings.loadSettings().auth.apiHeaders).toEqual({ 'x-z': '1', 'x-a': 'b' });
            expect(cat.info).not.toHaveBeenCalledWith(TAKEN_BACK);
        });

        test('a take-over that cannot be saved at the start writes nothing and records nothing, and the next start adopts it', () => {
            signedIn();
            olderBuildChanges((file) => ({ ...file, token: '', apiHeaders: {} }));
            const marker = fs.readFileSync(markerFile, 'utf8');
            loadFresh();
            const failing = failingWrites(CONFIG_TMP);

            expect(settings.loadSettings().auth.token).toBe('tok-1');

            expect(cat.info).not.toHaveBeenCalledWith(TAKEN_BACK);
            expect(stored(configFile).auth).toMatchObject({ token: 'tok-1' });
            // The sign-out is still what settings.json holds, and the marker still says what the mirror wrote before.
            expect(stored(legacyFile)).toMatchObject({ token: '', apiHeaders: {} });
            expect(fs.readFileSync(markerFile, 'utf8')).toBe(marker);

            failing.failing = false;
            loadFresh();

            expect(settings.loadSettings().auth.token).toBe('');
            expect(cat.info).toHaveBeenCalledWith(TAKEN_BACK);
            expect(stored(legacyFile)).toMatchObject({ token: '' });
        });

        test('nothing is taken over while the configuration in use is the defaults of a damaged one', () => {
            signedIn();
            olderBuildChanges((file) => ({ ...file, token: '', apiHeaders: {} }));
            fs.writeFileSync(configFile, '{"app":{"theme":');
            loadFresh(() => {
                jest.doMock('../../../src/ts/settings/importV1', () => ({
                    importV1Settings: () => ({ ok: false, code: 'migration-failed', detail: 'a pass exploded' }),
                }));
            });

            settings.loadSettings();

            expect(settings.getSettingsRecovery()?.code).toBe('settings-corrupt');
            expect(cat.info).not.toHaveBeenCalledWith(TAKEN_BACK);
            expect(fs.existsSync(configFile)).toBe(false);
        });
    });

    describe('a logout', () => {
        const COPY_CONFIG = JSON.stringify({
            version: 2,
            app: { theme: 'light' },
            auth: { token: 'tok-old', apiHeaders: { 'x-o': 'p' }, lastUsername: 'me', chosenPhotosMemberId: 'm-9' },
        });
        const COPY_SETTINGS = JSON.stringify({ theme: 'dark', token: 'tok-unimportable', apiHeaders: { 'x-u': 'v' } });
        const NO_SIGN_IN = JSON.stringify({ theme: 'dark', token: '', apiHeaders: {} });
        const arrangeCopies = () => {
            fs.writeFileSync(setAside('config.json.corrupt-2026-10-16T08-00-00-000Z'), COPY_CONFIG);
            fs.writeFileSync(setAside('settings.json.unimportable-2026-10-16T08-00-00-000Z'), COPY_SETTINGS);
            fs.writeFileSync(setAside('settings.json.unimportable-2026-10-16T09-00-00-000Z'), NO_SIGN_IN);
            fs.writeFileSync(setAside('config.json.corrupt-2026-10-16T10-00-00-000Z'), '{"auth":{"token":"tok-bad"');
            fs.writeFileSync(setAside('config.json.corrupt-2026-10-16T11-00-00-000Z'), '[1]');
        };

        test('takes the token and the headers out of every set-aside copy that parses, and leaves the others as they are', () => {
            signedIn();
            arrangeCopies();

            expect(settings.setSetting('token', '')).toBe(true);

            expect(stored(setAside('config.json.corrupt-2026-10-16T08-00-00-000Z'))).toEqual({
                version: 2,
                app: { theme: 'light' },
                auth: { token: '', apiHeaders: {}, lastUsername: '', chosenPhotosMemberId: '' },
            });
            expect(stored(setAside('settings.json.unimportable-2026-10-16T08-00-00-000Z'))).toEqual({
                theme: 'dark',
                token: '',
                apiHeaders: {},
            });
            // One that holds no sign-in is not rewritten; one that does not parse is left as it is.
            expect(fs.readFileSync(setAside('settings.json.unimportable-2026-10-16T09-00-00-000Z'), 'utf8')).toBe(
                NO_SIGN_IN,
            );
            expect(fs.readFileSync(setAside('config.json.corrupt-2026-10-16T10-00-00-000Z'), 'utf8')).toBe(
                '{"auth":{"token":"tok-bad"',
            );
            expect(fs.readFileSync(setAside('config.json.corrupt-2026-10-16T11-00-00-000Z'), 'utf8')).toBe('[1]');
            if (process.platform !== 'win32') {
                expect(fs.statSync(setAside('config.json.corrupt-2026-10-16T08-00-00-000Z')).mode & 0o777).toBe(0o600);
            }
        });

        test('the user name and the chosen-photos account go out of the copies too, and stay in the configuration and the live mirror', () => {
            signedIn();
            fs.writeFileSync(
                setAside('settings.json.unimportable-2026-10-16T12-00-00-000Z'),
                JSON.stringify({ theme: 'dark', lastUsername: 'me@example.com', chosenPhotosMemberId: 'm-7' }),
            );

            expect(settings.setSetting('token', '')).toBe(true);

            expect(stored(setAside('settings.json.unimportable-2026-10-16T12-00-00-000Z'))).toEqual({
                theme: 'dark',
                token: '',
                apiHeaders: {},
                lastUsername: '',
                chosenPhotosMemberId: '',
            });
            expect(stored(configFile).auth).toMatchObject({
                lastUsername: 'me@example.com',
                chosenPhotosMemberId: 'm-1',
            });
            expect(stored(legacyFile)).toMatchObject({ lastUsername: 'me@example.com', chosenPhotosMemberId: 'm-1' });
        });

        test("a configuration that merely holds no token is no sign-out: starts and saves leave the copies' sign-in alone", () => {
            signedIn();
            settings.setSetting('token', '');
            arrangeCopies();
            // (The copies were made after the logout; they hold the sign-in of the account that was signed out.)

            loadFresh();
            settings.loadSettings();
            settings.setSetting('theme', 'light');
            // A second "sign-out" of a token that is not stored is none either.
            settings.setSetting('token', '');
            loadFresh();
            settings.loadSettings();

            expect(stored(setAside('config.json.corrupt-2026-10-16T08-00-00-000Z')).auth).toMatchObject({
                token: 'tok-old',
            });
            expect(stored(setAside('settings.json.unimportable-2026-10-16T08-00-00-000Z'))).toMatchObject({
                token: 'tok-unimportable',
            });
        });

        test('at the start, the copies set aside more than two weeks ago lose the sign-in they hold and keep their settings; the recent ones and the original are left', () => {
            signedIn();
            const stamp = (ms: number) => new Date(ms).toISOString().replace(/[:.]/g, '-');
            const old = setAside(`config.json.corrupt-${stamp(Date.now() - 15 * 24 * 3600 * 1000)}`);
            const oldSettings = setAside(`settings.json.unimportable-${stamp(Date.now() - 20 * 24 * 3600 * 1000)}`);
            const recent = setAside(`config.json.corrupt-${stamp(Date.now() - 3 * 24 * 3600 * 1000)}`);
            const original = setAside('settings.json.original');
            fs.writeFileSync(old, COPY_CONFIG);
            fs.writeFileSync(oldSettings, COPY_SETTINGS);
            fs.writeFileSync(recent, COPY_CONFIG);
            fs.writeFileSync(original, COPY_SETTINGS);

            loadFresh();
            settings.loadSettings();

            expect(stored(old)).toMatchObject({
                app: { theme: 'light' },
                auth: { token: '', apiHeaders: {}, lastUsername: '' },
            });
            expect(stored(oldSettings)).toMatchObject({ theme: 'dark', token: '', apiHeaders: {} });
            expect(stored(recent).auth).toMatchObject({ token: 'tok-old' });
            expect(stored(original)).toMatchObject({ token: 'tok-unimportable' });
        });

        describe('when a copy could not be rewritten', () => {
            const FAILING_COPY = /config\.json\.corrupt-2026-10-16T08-00-00-000Z\.\d+\.[0-9a-f]+\.tmp$/;
            const copy = () => stored(setAside('config.json.corrupt-2026-10-16T08-00-00-000Z')).auth;

            test('the record is kept, and the copy is cleared at the next save', () => {
                signedIn();
                arrangeCopies();
                const failing = failingWrites(FAILING_COPY);

                expect(settings.setSetting('token', '')).toBe(true);

                expect(copy()).toMatchObject({ token: 'tok-old' });
                expect(stored(markerFile).signOutScrubPending).toEqual(expect.any(String));
                // The other copies were cleared meanwhile.
                expect(stored(setAside('settings.json.unimportable-2026-10-16T08-00-00-000Z'))).toMatchObject({
                    token: '',
                });

                failing.failing = false;
                expect(settings.setSetting('theme', 'light')).toBe(true);

                expect(copy()).toMatchObject({ token: '', lastUsername: '' });
                expect(stored(markerFile)).not.toHaveProperty('signOutScrubPending');
            });

            test('the record is kept across a restart, and the copy is cleared at the start', () => {
                signedIn();
                arrangeCopies();
                const failing = failingWrites(FAILING_COPY);
                expect(settings.setSetting('token', '')).toBe(true);
                expect(copy()).toMatchObject({ token: 'tok-old' });
                failing.failing = false;

                loadFresh();
                settings.loadSettings();

                expect(copy()).toMatchObject({ token: '', lastUsername: '' });
                expect(stored(markerFile)).not.toHaveProperty('signOutScrubPending');
            });

            test('a copy that still cannot be rewritten at the restart keeps the record, and the next save tries again', () => {
                signedIn();
                arrangeCopies();
                failingWrites(FAILING_COPY);
                expect(settings.setSetting('token', '')).toBe(true);

                loadFresh();
                settings.loadSettings();
                expect(copy()).toMatchObject({ token: 'tok-old' });
                expect(stored(markerFile).signOutScrubPending).toEqual(expect.any(String));

                jest.restoreAllMocks();
                expect(settings.setSetting('theme', 'light')).toBe(true);

                expect(copy()).toMatchObject({ token: '' });
                expect(stored(markerFile)).not.toHaveProperty('signOutScrubPending');
            });

            test('and the record is cleared when every copy was rewritten at once', () => {
                signedIn();
                arrangeCopies();

                expect(settings.setSetting('token', '')).toBe(true);

                expect(stored(markerFile)).not.toHaveProperty('signOutScrubPending');
            });
        });

        test('a copy that cannot be read is logged without its text, and the others are still cleared', () => {
            signedIn();
            arrangeCopies();
            const real = fs.readFileSync;
            jest.spyOn(fs, 'readFileSync').mockImplementation(((file: fs.PathLike | number, ...rest: unknown[]) => {
                if (String(file).endsWith('config.json.corrupt-2026-10-16T08-00-00-000Z')) {
                    throw Object.assign(new Error(`EIO: i/o error, open '${String(file)}'`), { code: 'EIO' });
                }
                return (real as (...args: unknown[]) => unknown)(file, ...rest);
            }) as typeof fs.readFileSync);

            expect(settings.setSetting('token', '')).toBe(true);

            // The errno only: the error's own text names the path, and with it the user's account name.
            expect(cat.error).toHaveBeenCalledWith(
                'config.json.corrupt-2026-10-16T08-00-00-000Z could not be rewritten: EIO',
            );
            expect(everyLog()).not.toContain(userData);
            expect(stored(setAside('settings.json.unimportable-2026-10-16T08-00-00-000Z'))).toMatchObject({
                token: '',
            });
            expect(everyLog()).not.toContain('tok-old');
        });

        test('a directory that cannot be listed has no copies to clear, and the logout stands', () => {
            signedIn();
            arrangeCopies();
            const real = fs.readdirSync;
            jest.spyOn(fs, 'readdirSync').mockImplementation(((...args: unknown[]) => {
                if (String(args[0]) === userData) throw new Error('EACCES');
                return (real as (...rest: unknown[]) => unknown)(...args);
            }) as typeof fs.readdirSync);

            expect(settings.setSetting('token', '')).toBe(true);

            expect(stored(setAside('config.json.corrupt-2026-10-16T08-00-00-000Z')).auth).toMatchObject({
                token: 'tok-old',
            });
            expect(stored(configFile).auth).toMatchObject({ token: '' });
        });
    });

    describe('the settings.json the configuration could not be restored from', () => {
        // The mirror has written; then both the configuration and settings.json are damaged.
        const damaged = (legacyText = '{broken') => {
            signedIn();
            fs.writeFileSync(configFile, '{"app":{"theme":');
            fs.writeFileSync(legacyFile, legacyText);
        };
        const unimportable = () =>
            fs.readdirSync(userData).filter((name) => name.startsWith('settings.json.unimportable-'));
        const failing = (reason: string) =>
            loadFresh(() => {
                jest.doMock('../../../src/ts/settings/importV1', () => ({
                    importV1Settings: () => ({ ok: false, code: reason, detail: 'a pass exploded' }),
                }));
            });

        test('is one state, however often it is read: defaults, a notice, saves allowed, and the file untouched', () => {
            damaged();
            loadFresh();

            const states = [0, 1, 2].map(() => {
                const loaded = settings.loadSettings();
                expect(loaded).toEqual(settings.getDefaultSettings());
                return settings.getSettingsRecovery();
            });
            settings.getSetting('theme');
            states.push(settings.getSettingsRecovery());

            const [backup] = fs.readdirSync(userData).filter((name) => name.startsWith('config.json.corrupt-'));
            for (const state of states) {
                expect(state).toEqual({
                    code: 'settings-corrupt',
                    path: path.join(userData, backup),
                    blocking: false,
                    reimportSource: legacyFile,
                });
            }
            expect(fs.readFileSync(legacyFile, 'utf8')).toBe('{broken');
            expect(unimportable()).toEqual([]);
            expect(fs.existsSync(configFile)).toBe(false);
        });

        test.each([
            ['damaged', 'corrupt'],
            ['one the pipeline cannot convert', 'migration-failed'],
        ])(
            'the first save sets a %s file aside before the mirror writes, and the notice says where',
            (_name, reason) => {
                damaged(reason === 'corrupt' ? '{broken' : '{"theme":"dark"}');
                if (reason === 'corrupt') loadFresh();
                else failing(reason);
                settings.loadSettings();
                settings.loadSettings();

                expect(settings.setSetting('theme', 'light')).toBe(true);

                const [copy] = unimportable();
                expect(unimportable()).toHaveLength(1);
                expect(fs.readFileSync(path.join(userData, copy), 'utf8')).toBe(
                    reason === 'corrupt' ? '{broken' : '{"theme":"dark"}',
                );
                expect(stored(legacyFile)).toMatchObject({ theme: 'light' });
                expect(stored(configFile).app).toMatchObject({ theme: 'light' });
                const [backup] = fs.readdirSync(userData).filter((name) => name.startsWith('config.json.corrupt-'));
                expect(settings.getSettingsRecovery()).toEqual({
                    code: 'settings-corrupt',
                    path: path.join(userData, backup),
                    blocking: false,
                    settingsSetAside: path.join(userData, copy),
                    // (And the copy is what a Re-import reads now.)
                    reimportSource: path.join(userData, copy),
                });
                // Once: the next save mirrors, and keeps no second copy.
                expect(settings.setSetting('theme', 'dark')).toBe(true);
                expect(unimportable()).toHaveLength(1);
            },
        );

        test('a settings.json that is not there leaves nothing to set aside, and the save mirrors', () => {
            damaged();
            fs.rmSync(legacyFile);
            loadFresh();
            settings.loadSettings();

            expect(settings.setSetting('theme', 'light')).toBe(true);

            expect(unimportable()).toEqual([]);
            expect(stored(legacyFile)).toMatchObject({ theme: 'light' });
            expect(settings.getSettingsRecovery()).not.toHaveProperty('settingsSetAside');
        });

        test('a file that cannot be set aside is not written over: the save stands, and the next one tries again', () => {
            damaged();
            loadFresh();
            settings.loadSettings();
            const real = fs.openSync;
            let failing = true;
            jest.spyOn(fs, 'openSync').mockImplementation(((file: fs.PathLike, ...rest: unknown[]) => {
                if (failing && /settings\.json\.unimportable-.*\.tmp$/.test(String(file))) throw new Error('ENOSPC');
                return (real as (...args: unknown[]) => unknown)(file, ...rest);
            }) as typeof fs.openSync);

            expect(settings.setSetting('theme', 'light')).toBe(true);

            expect(fs.readFileSync(legacyFile, 'utf8')).toBe('{broken');
            expect(unimportable()).toEqual([]);
            expect(cat.warning).toHaveBeenCalledWith(
                expect.stringContaining('settings.json could not be set aside, so it is not overwritten: ENOSPC'),
            );
            expect(settings.getSettingsRecovery()).not.toHaveProperty('settingsSetAside');

            failing = false;
            expect(settings.setSetting('theme', 'dark')).toBe(true);

            expect(unimportable()).toHaveLength(1);
            expect(stored(legacyFile)).toMatchObject({ theme: 'dark' });
        });

        test('a settings.json that is gone by the first save leaves nothing to set aside, and says none was', () => {
            damaged();
            loadFresh();
            settings.loadSettings();
            expect(settings.getSettingsRecovery()?.code).toBe('settings-corrupt');
            fs.rmSync(legacyFile);

            expect(settings.setSetting('theme', 'light')).toBe(true);

            expect(unimportable()).toEqual([]);
            expect(stored(configFile).app).toMatchObject({ theme: 'light' });
            expect(settings.getSettingsRecovery()).not.toHaveProperty('settingsSetAside');
        });

        test('the sign-in in the copy of the episode survives several starts and saves, and a real logout still scrubs it', () => {
            damaged(JSON.stringify({ theme: 'dark', token: 'tok-keep', lastUsername: 'me@example.com' }));
            failing('migration-failed');
            settings.loadSettings();
            settings.setSetting('theme', 'light');
            const [copy] = unimportable();
            // (The configuration of that episode held no token, which is not a sign-out.)
            for (let start = 0; start < 3; start++) {
                loadFresh();
                settings.loadSettings();
                settings.setSetting('theme', start % 2 === 0 ? 'dark' : 'light');
            }
            expect(stored(path.join(userData, copy))).toMatchObject({
                token: 'tok-keep',
                lastUsername: 'me@example.com',
            });

            // The user signs in and out again: a real sign-out clears every copy.
            settings.setSetting('token', 'tok-new');
            settings.setSetting('token', '');

            expect(stored(path.join(userData, copy))).toMatchObject({ token: '', lastUsername: '' });
        });

        test('a Re-import after the first save imports the copy of this episode that the user fixed in place, never another one in the folder', () => {
            damaged();
            loadFresh();
            settings.loadSettings();
            settings.setSetting('theme', 'light');
            const [copy] = unimportable();
            // Copies of earlier problems, one of them named later than this episode's: they are not the file that was fixed.
            fs.writeFileSync(
                path.join(userData, 'settings.json.unimportable-2000-01-01T00-00-00-000Z'),
                '{"theme":"old"}',
            );
            fs.writeFileSync(
                path.join(userData, 'settings.json.unimportable-2999-01-01T00-00-00-000Z'),
                '{"theme":"later"}',
            );
            fs.writeFileSync(
                path.join(userData, copy),
                JSON.stringify({ theme: 'dark', token: 'tok-fixed', lastUsername: 'fixed' }),
            );

            const result = settings.reimportFromV1Detailed();

            expect(result.ok).toBe(true);
            expect(settings.getSettingsRecovery()).toBeNull();
            expect(settings.loadSettings()).toMatchObject({
                app: { theme: 'dark' },
                auth: { token: 'tok-fixed', lastUsername: 'fixed' },
            });
            // The mirror of what was imported is what settings.json holds now.
            expect(stored(legacyFile)).toMatchObject({ theme: 'dark', token: 'tok-fixed' });
            loadFresh();
            settings.loadSettings();
            expect(settings.getSettingsRecovery()).toBeNull();
        });

        test("a second damaged-configuration episode in the same process does not name or re-import the first one's copy", () => {
            damaged();
            loadFresh();
            settings.loadSettings();
            settings.setSetting('theme', 'light');
            const [first] = unimportable();
            expect(settings.getSettingsRecovery()).toMatchObject({ settingsSetAside: path.join(userData, first) });
            // The first episode's copy would import; the second episode's files do not.
            fs.writeFileSync(path.join(userData, first), JSON.stringify({ theme: 'stale', token: 'tok-stale' }));
            fs.writeFileSync(configFile, '{"app":{"theme2":');
            fs.writeFileSync(legacyFile, '{broken again');

            settings.loadSettings();

            expect(settings.getSettingsRecovery()).toMatchObject({ code: 'settings-corrupt' });
            expect(settings.getSettingsRecovery()).not.toHaveProperty('settingsSetAside');
            // (Nor does the marker point at it any more.)
            expect(stored(markerFile)).not.toHaveProperty('unimportableCopy');
            // Re-import reads settings.json, which the user fixes now, not the first copy.
            fs.writeFileSync(legacyFile, JSON.stringify({ theme: 'dark', token: 'tok-fixed' }));
            expect(settings.reimportFromV1()).toBe(true);
            expect(settings.loadSettings()).toMatchObject({ app: { theme: 'dark' }, auth: { token: 'tok-fixed' } });
        });

        test('a Re-import in another process (the CLI) finds the copy the first process set aside, and the freshly mirrored defaults are not what it imports', () => {
            damaged();
            loadFresh();
            settings.loadSettings();
            settings.setSetting('theme', 'light');
            const [copy] = unimportable();
            expect(stored(markerFile).unimportableCopy).toBe(path.join(userData, copy));
            // The user fixes the copy in place; settings.json is the mirror of the defaults by now.
            fs.writeFileSync(path.join(userData, copy), JSON.stringify({ theme: 'dark', token: 'tok-fixed' }));

            // A new process: nothing of the episode is in its memory.
            loadFresh();
            const result = settings.reimportFromV1Detailed();

            expect(result.ok).toBe(true);
            expect(settings.loadSettings()).toMatchObject({ app: { theme: 'dark' }, auth: { token: 'tok-fixed' } });
            // The episode is over: the pointer is gone, and the next re-import reads settings.json again.
            expect(stored(markerFile)).not.toHaveProperty('unimportableCopy');
            expect(stored(legacyFile)).toMatchObject({ theme: 'dark', token: 'tok-fixed' });
        });

        test.each([
            [
                'a file elsewhere',
                () => path.join(root, 'elsewhere', 'settings.json.unimportable-2026-01-01T00-00-00-000Z'),
            ],
            ['a file here that is not named as a copy', () => path.join(userData, 'config.json')],
            ['a path with a parent segment', () => path.join(userData, '..', 'userData', 'x', '..', 'config.json')],
            [
                'a raw path named as a copy whose `..` leads to another directory',
                // (The text starts with the data folder and ends in the right name; it resolves to a sibling folder.)
                () =>
                    `${userData}/sub/../../elsewhere/settings.json.unimportable-${new Date().toISOString().replace(/[:.]/g, '-')}`,
            ],
        ])(
            'a remembered path that is %s is not a copy to fix: settings.json is imported instead',
            (_name, remembered) => {
                damaged();
                loadFresh();
                settings.loadSettings();
                settings.setSetting('theme', 'light');
                const target = remembered();
                // (A path with `..` leads through a directory that exists.)
                fs.mkdirSync(path.join(userData, 'sub'), { recursive: true });
                fs.mkdirSync(path.join(root, 'elsewhere'), { recursive: true });
                fs.mkdirSync(path.dirname(target), { recursive: true });
                try {
                    fs.writeFileSync(target, JSON.stringify({ theme: 'other', token: 'tok-other' }), { flag: 'wx' });
                } catch (error) {
                    // Already there (a file, or a directory) is what some of these paths are.
                    if (!isPlainObject(error) || error.code !== 'EEXIST') throw error;
                }
                expect(fs.existsSync(target)).toBe(true);
                fs.writeFileSync(markerFile, JSON.stringify({ ...stored(markerFile), unimportableCopy: target }));
                fs.writeFileSync(legacyFile, JSON.stringify({ theme: 'dark', token: 'tok-fixed' }));
                loadFresh();

                expect(settings.reimportFromV1Detailed()).toMatchObject({ ok: true, source: legacyFile });

                expect(settings.loadSettings().auth.token).toBe('tok-fixed');
            },
        );

        test('a raw path with `..` that resolves to the copy beside settings.json is that copy', () => {
            damaged();
            loadFresh();
            settings.loadSettings();
            settings.setSetting('theme', 'light');
            const [copy] = unimportable();
            fs.writeFileSync(path.join(userData, copy), JSON.stringify({ token: 'tok-fixed' }));
            fs.mkdirSync(path.join(userData, 'sub'));
            fs.writeFileSync(
                markerFile,
                JSON.stringify({ ...stored(markerFile), unimportableCopy: `${userData}/sub/../${copy}` }),
            );

            loadFresh();

            expect(settings.reimportFromV1Detailed()).toMatchObject({ ok: true, source: path.join(userData, copy) });
            expect(settings.loadSettings().auth.token).toBe('tok-fixed');
        });

        test("a save in another process does not end the episode: a CLI run during the GUI's keeps the copy a re-import takes", () => {
            damaged();
            loadFresh();
            settings.loadSettings();
            settings.setSetting('theme', 'light');
            const [copy] = unimportable();
            fs.writeFileSync(path.join(userData, copy), JSON.stringify({ token: 'tok-fixed' }));

            // Another process (a CLI vote) saves meanwhile.
            loadFresh();
            settings.loadSettings();
            expect(settings.setSetting('theme', 'dark')).toBe(true);
            expect(settings.mergeTitlePins({ '5': 'Sunset' })).toBe(true);

            expect(stored(markerFile).unimportableCopy).toBe(path.join(userData, copy));
            loadFresh();
            expect(settings.reimportFromV1Detailed()).toMatchObject({ ok: true, source: path.join(userData, copy) });
            expect(settings.loadSettings().auth.token).toBe('tok-fixed');
        });

        test('a remembered copy is not the one to fix for ever: after two weeks a re-import reads settings.json', () => {
            damaged();
            loadFresh();
            settings.loadSettings();
            settings.setSetting('theme', 'light');
            const [copy] = unimportable();
            fs.writeFileSync(path.join(userData, copy), JSON.stringify({ token: 'tok-old-copy' }));
            fs.writeFileSync(legacyFile, JSON.stringify({ theme: 'later', token: 'tok-later' }));
            loadFresh();
            const made = Date.parse(
                copy
                    .replace('settings.json.unimportable-', '')
                    .replace(/T(\d\d)-(\d\d)-(\d\d)-(\d{3}Z)/, 'T$1:$2:$3.$4'),
            );
            const clock = jest.spyOn(Date, 'now').mockReturnValue(made + 13 * 24 * 3600 * 1000);
            expect(settings.getSettingsRecovery()).toBeNull();
            clock.mockReturnValue(made + 15 * 24 * 3600 * 1000);

            expect(settings.reimportFromV1Detailed()).toMatchObject({ ok: true, source: legacyFile });

            expect(settings.loadSettings().auth.token).toBe('tok-later');
        });

        test('a copy with no time in its name is not aged out', () => {
            damaged();
            loadFresh();
            settings.loadSettings();
            settings.setSetting('theme', 'light');
            const named = path.join(userData, 'settings.json.unimportable-by-hand');
            fs.writeFileSync(named, JSON.stringify({ token: 'tok-by-hand' }));
            fs.writeFileSync(markerFile, JSON.stringify({ ...stored(markerFile), unimportableCopy: named }));
            loadFresh();
            jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 400 * 24 * 3600 * 1000);

            expect(settings.reimportFromV1Detailed()).toMatchObject({ ok: true, source: named });
        });

        test('with no marker to record it in, the set-aside is made all the same, and a re-import then reads settings.json', () => {
            damaged();
            loadFresh();
            settings.loadSettings();
            fs.rmSync(markerFile);

            expect(settings.setSetting('theme', 'light')).toBe(true);

            expect(unimportable()).toHaveLength(1);
            expect(fs.existsSync(markerFile)).toBe(false);
            fs.writeFileSync(legacyFile, JSON.stringify({ theme: 'dark', token: 'tok-fixed' }));
            loadFresh();
            expect(settings.reimportFromV1()).toBe(true);
            expect(settings.loadSettings().auth.token).toBe('tok-fixed');
        });

        test('the same after a restart of the app: a re-import with no notice (nothing is wrong now) still takes the fixed copy', () => {
            damaged();
            loadFresh();
            settings.loadSettings();
            settings.setSetting('theme', 'light');
            const [copy] = unimportable();
            fs.writeFileSync(path.join(userData, copy), JSON.stringify({ token: 'tok-fixed' }));
            loadFresh();
            settings.loadSettings();
            expect(settings.getSettingsRecovery()).toBeNull();

            expect(settings.reimportFromV1()).toBe(true);

            expect(settings.loadSettings().auth.token).toBe('tok-fixed');
        });

        test('with no copy of this episode, a stale one in the folder is not taken: the settings.json fixed in place is', () => {
            damaged();
            // A copy left by an earlier problem, which would import.
            fs.writeFileSync(
                path.join(userData, 'settings.json.unimportable-2999-01-01T00-00-00-000Z'),
                JSON.stringify({ theme: 'stale', token: 'tok-stale' }),
            );
            loadFresh();
            settings.loadSettings();
            fs.writeFileSync(legacyFile, JSON.stringify({ theme: 'dark', token: 'tok-fixed' }));

            expect(settings.reimportFromV1()).toBe(true);

            expect(settings.loadSettings()).toMatchObject({ app: { theme: 'dark' }, auth: { token: 'tok-fixed' } });
        });

        test.each([
            ['an Error', () => new Error('EIO'), 'EIO'],
            ['a value that carries no message', () => 'weird', 'unknown error'],
        ])(
            'a copy of this episode that cannot be read (%s) says why in the log, and nothing changes',
            (_name, thrown, said) => {
                damaged();
                loadFresh();
                settings.loadSettings();
                settings.setSetting('theme', 'light');
                const [copy] = unimportable();
                const real = fs.readFileSync;
                jest.spyOn(fs, 'readFileSync').mockImplementation(((file: fs.PathLike | number, ...rest: unknown[]) => {
                    if (String(file).endsWith(copy)) throw thrown();
                    return (real as (...args: unknown[]) => unknown)(file, ...rest);
                }) as typeof fs.readFileSync);

                expect(settings.reimportFromV1()).toBe(false);

                expect(cat.error).toHaveBeenCalledWith(expect.stringContaining(said));
                expect(settings.getSettingsRecovery()?.code).toBe('settings-corrupt');
            },
        );

        test('a copy of this episode that is gone is forgotten: settings.json is imported instead', () => {
            damaged();
            loadFresh();
            settings.loadSettings();
            settings.setSetting('theme', 'light');
            const [copy] = unimportable();
            fs.rmSync(path.join(userData, copy));
            fs.writeFileSync(legacyFile, JSON.stringify({ theme: 'dark', token: 'tok-fixed' }));

            expect(settings.reimportFromV1()).toBe(true);

            expect(settings.loadSettings()).toMatchObject({ app: { theme: 'dark' }, auth: { token: 'tok-fixed' } });
            expect(stored(markerFile)).not.toHaveProperty('unimportableCopy');
        });

        test('a copy that still does not import leaves everything as it is, and says it did not work', () => {
            damaged();
            loadFresh();
            settings.loadSettings();
            settings.setSetting('theme', 'light');
            const [copy] = unimportable();

            expect(settings.reimportFromV1Detailed()).toEqual({
                ok: false,
                setAside: null,
                source: path.join(userData, copy),
            });

            expect(settings.getSettingsRecovery()?.code).toBe('settings-corrupt');
            expect(stored(configFile).app).toMatchObject({ theme: 'light' });
        });
    });

    describe('a re-import', () => {
        test('takes the sign-in from settings.json too, and says where the settings and sign-in it replaced were set aside', () => {
            signedIn();
            // settings.json holds the sign-in of another account, as an older build left it (and fixed by hand).
            olderBuildChanges((file) => ({ ...file, token: 'tok-9', lastUsername: 'other@example.com' }));

            const result = settings.reimportFromV1Detailed();

            const [copy] = fs.readdirSync(userData).filter((name) => name.startsWith('config.json.corrupt-'));
            expect(result).toEqual({ ok: true, setAside: path.join(userData, copy), source: legacyFile });
            expect(settings.loadSettings().auth).toMatchObject({ token: 'tok-9', lastUsername: 'other@example.com' });
            // What was in use went to the copy, sign-in included, until the next logout clears it.
            expect(stored(path.join(userData, copy)).auth).toMatchObject({ token: 'tok-1' });
            expect(settings.reimportFromV1()).toBe(true);
        });

        test('says nothing was set aside when there was no configuration in use, and that it failed when there is no settings.json', () => {
            signedIn();
            fs.rmSync(configFile);

            expect(settings.reimportFromV1Detailed()).toEqual({ ok: true, setAside: null, source: legacyFile });

            fs.rmSync(legacyFile);
            fs.rmSync(configFile);
            expect(settings.reimportFromV1Detailed()).toEqual({ ok: false, setAside: null, source: legacyFile });
        });
    });

    describe('a sign-in an older build changes while this build runs', () => {
        test('a logout in an older build is kept by the next save, in the configuration and in both files', () => {
            signedIn();
            loadFresh();
            settings.loadSettings();
            // The older build's own `logout`, while the app is running.
            olderBuildChanges((file) => ({ ...file, token: '', apiHeaders: {} }));

            expect(settings.setSetting('theme', 'light')).toBe(true);

            expect(stored(configFile).auth).toMatchObject({ token: '', apiHeaders: {} });
            expect(stored(configFile).app).toMatchObject({ theme: 'light' });
            expect(stored(legacyFile)).toMatchObject({ theme: 'light', token: '', apiHeaders: {} });
            expect(cat.info).toHaveBeenCalledWith(TAKEN_BACK);
            expect(everyLog()).not.toContain('tok-1');
            // It is the sign-in now: scrubbed copies, and the next save has nothing more to take over.
            cat.info.mockClear();
            expect(settings.setSetting('theme', 'dark')).toBe(true);
            expect(cat.info).not.toHaveBeenCalledWith(TAKEN_BACK);
            expect(stored(legacyFile)).toMatchObject({ theme: 'dark', token: '' });
        });

        test('another account an older build signed in is kept by the next save too', () => {
            signedIn();
            loadFresh();
            settings.loadSettings();
            olderBuildChanges((file) => ({ ...file, token: 'tok-2', lastUsername: 'other@example.com' }));

            expect(settings.mergeTitlePins({ '5': 'Sunset' })).toBe(true);

            expect(stored(configFile).auth).toMatchObject({ token: 'tok-2', lastUsername: 'other@example.com' });
            expect(stored(legacyFile)).toMatchObject({
                token: 'tok-2',
                challengeSettings: { titlePins: { '5': 'Sunset' } },
            });
        });

        test("the sign-in the app itself changed is not taken for an older build's", () => {
            signedIn();
            loadFresh();
            settings.loadSettings();

            expect(settings.setSetting('token', 'tok-3')).toBe(true);
            expect(settings.setSetting('lastUsername', 'third@example.com')).toBe(true);

            expect(cat.info).not.toHaveBeenCalledWith(TAKEN_BACK);
            expect(stored(legacyFile)).toMatchObject({ token: 'tok-3', lastUsername: 'third@example.com' });
        });

        test('a take-over whose configuration cannot be saved leaves settings.json and the marker as they are, and the next save adopts it', () => {
            signedIn();
            loadFresh();
            settings.loadSettings();
            olderBuildChanges((file) => ({ ...file, token: '', apiHeaders: {}, theme: 'dark' }));
            const marker = fs.readFileSync(markerFile, 'utf8');
            // The save of the theme lands; the one that adopts the sign-out does not.
            const failing = failingWrites(CONFIG_TMP, 1);

            expect(settings.setSetting('theme', 'light')).toBe(true);

            expect(stored(configFile).app).toMatchObject({ theme: 'light' });
            expect(stored(configFile).auth).toMatchObject({ token: 'tok-1' });
            expect(stored(legacyFile)).toMatchObject({ theme: 'dark', token: '' });
            expect(fs.readFileSync(markerFile, 'utf8')).toBe(marker);
            expect(cat.warning).toHaveBeenCalledWith(expect.stringContaining('could not be brought up to date'));

            failing.failing = false;
            expect(settings.setSetting('theme', 'dark')).toBe(true);

            expect(stored(configFile).auth).toMatchObject({ token: '' });
            expect(stored(legacyFile)).toMatchObject({ theme: 'dark', token: '' });
        });

        test('a take-over is declined while the configuration in use is the defaults of a damaged one, and the mirror goes on', () => {
            signedIn();
            fs.writeFileSync(configFile, '{"app":{"theme":');
            olderBuildChanges((file) => ({ ...file, token: '', apiHeaders: {} }));
            loadFresh(() => {
                jest.doMock('../../../src/ts/settings/importV1', () => ({
                    importV1Settings: () => ({ ok: false, code: 'migration-failed', detail: 'a pass exploded' }),
                }));
            });
            settings.loadSettings();

            expect(settings.setSetting('theme', 'light')).toBe(true);

            expect(cat.info).not.toHaveBeenCalledWith(TAKEN_BACK);
            expect(stored(configFile).auth).toMatchObject({ token: '' });
            expect(stored(legacyFile)).toMatchObject({ theme: 'light' });
        });
    });

    describe('compared field by field', () => {
        test('an older build that dropped chosenPhotosMemberId, and then an account and member changed here before the next mirror landed: nothing older is adopted', () => {
            signedIn();
            // The older build prunes the key it does not know and writes the file back.
            olderBuildChanges(({ chosenPhotosMemberId: _dropped, ...file }) => file);
            loadFresh();
            const failing = failingWrites(LEGACY_TMP);
            settings.loadSettings();
            // Another account here, and another member: none of it reaches settings.json.
            settings.setSetting('token', 'tok-2');
            settings.setSetting('lastUsername', 'other@example.com');
            settings.setSetting('chosenPhotosMemberId', 'm-2');
            expect(stored(legacyFile)).toMatchObject({ token: 'tok-1', lastUsername: 'me@example.com' });
            expect(stored(legacyFile)).not.toHaveProperty('chosenPhotosMemberId');
            failing.failing = false;

            loadFresh();

            expect(settings.loadSettings().auth).toMatchObject({
                token: 'tok-2',
                lastUsername: 'other@example.com',
                chosenPhotosMemberId: 'm-2',
            });
            expect(cat.info).not.toHaveBeenCalledWith(TAKEN_BACK);
            expect(stored(legacyFile)).toMatchObject({
                token: 'tok-2',
                lastUsername: 'other@example.com',
                chosenPhotosMemberId: 'm-2',
            });
        });

        test('only the fields the older build changed are adopted: what this build changed since stays', () => {
            signedIn();
            loadFresh();
            const failing = failingWrites(LEGACY_TMP);
            settings.loadSettings();
            // This build's change does not reach settings.json; the older build signs out in it.
            settings.setSetting('lastUsername', 'newer@example.com');
            olderBuildChanges((file) => ({ ...file, token: '', apiHeaders: {} }));
            failing.failing = false;

            expect(settings.setSetting('theme', 'light')).toBe(true);

            expect(stored(configFile).auth).toMatchObject({
                token: '',
                apiHeaders: {},
                lastUsername: 'newer@example.com',
            });
            expect(stored(legacyFile)).toMatchObject({ token: '', lastUsername: 'newer@example.com' });
        });
    });

    describe('the fingerprints of what this build wrote', () => {
        test('a mirror write that could not be recorded as pending is not made', () => {
            signedIn();
            const before = fs.readFileSync(legacyFile, 'utf8');
            failingWrites(MARKER_TMP);

            expect(settings.setSetting('theme', 'light')).toBe(true);

            expect(fs.readFileSync(legacyFile, 'utf8')).toBe(before);
            expect(cat.warning).toHaveBeenCalledWith(expect.stringContaining('could not be brought up to date'));
        });

        test("a mirror that did not land leaves the sign-in it holds known (confirmed), so the next start does not take it for an older build's", () => {
            signedIn();
            // The next sign-in is recorded as pending, and its write to settings.json fails.
            const failing = failingWrites(LEGACY_TMP);
            expect(settings.setSetting('token', 'tok-2')).toBe(true);
            expect(stored(legacyFile)).toMatchObject({ token: 'tok-1' });
            expect(stored(markerFile).signInPending).not.toBe(stored(markerFile).signInConfirmed);
            failing.failing = false;

            loadFresh();

            expect(settings.loadSettings().auth.token).toBe('tok-2');
            expect(cat.info).not.toHaveBeenCalledWith(TAKEN_BACK);
            expect(stored(legacyFile)).toMatchObject({ token: 'tok-2' });
        });

        test('a mirror that landed whose record failed leaves the sign-in it holds known (pending), even when the next change here is not mirrored either', () => {
            signedIn();
            // The mirror of tok-2 lands (the pending record is made first), the record after it fails.
            const record = failingWrites(MARKER_TMP, 1);
            expect(settings.setSetting('token', 'tok-2')).toBe(true);
            expect(stored(legacyFile)).toMatchObject({ token: 'tok-2' });
            expect(stored(markerFile).signInConfirmed).not.toBe(stored(markerFile).signInPending);
            record.failing = false;
            // The next change here is saved but not mirrored.
            const mirror = failingWrites(LEGACY_TMP);
            expect(settings.setSetting('token', 'tok-3')).toBe(true);
            expect(stored(legacyFile)).toMatchObject({ token: 'tok-2' });
            mirror.failing = false;

            loadFresh();

            // settings.json holds what this build wrote last (tok-2), not an older build's change: tok-3 is the sign-in.
            expect(settings.loadSettings().auth.token).toBe('tok-3');
            expect(cat.info).not.toHaveBeenCalledWith(TAKEN_BACK);
            expect(stored(legacyFile)).toMatchObject({ token: 'tok-3' });
        });

        test("what neither fingerprint knows is an older build's", () => {
            signedIn();
            olderBuildChanges((file) => ({ ...file, token: 'tok-9' }));

            loadFresh();

            expect(settings.loadSettings().auth.token).toBe('tok-9');
            expect(cat.info).toHaveBeenCalledWith(TAKEN_BACK);
        });
    });

    describe('the marker of a mirror that was there already', () => {
        test('a start that finds settings.json the mirror already records it confirmed, with no pending record', () => {
            signedIn();
            fs.writeFileSync(
                markerFile,
                JSON.stringify({ ...stored(markerFile), signInPending: undefined, signInConfirmed: undefined }),
            );

            loadFresh();
            settings.loadSettings();

            expect(stored(markerFile)).toMatchObject({ signInConfirmed: expect.any(String) });
            expect(stored(markerFile)).not.toHaveProperty('signInPending');
        });
    });

    describe('Start fresh', () => {
        const unimportable = () =>
            fs.readdirSync(userData).filter((name) => name.startsWith('settings.json.unimportable-'));

        test('says where the file was kept: as the original, or under a name of its own when the original is taken', () => {
            fs.writeFileSync(legacyFile, '{broken');
            loadFresh();
            settings.loadSettings();
            expect(settings.getSettingsRecovery()?.code).toBe('settings-import-failed');

            expect(settings.startFreshDetailed()).toEqual({
                ok: true,
                keptAt: path.join(userData, 'settings.json.original'),
            });
            expect(fs.readFileSync(path.join(userData, 'settings.json.original'), 'utf8')).toBe('{broken');

            // Again, with the original taken: the file the mirror wrote is not kept over it, and a failed import is.
            fs.rmSync(configFile);
            fs.rmSync(markerFile);
            fs.writeFileSync(legacyFile, '{broken again');
            loadFresh();
            settings.loadSettings();
            const result = settings.startFreshDetailed();
            expect(result.ok).toBe(true);
            expect(result.keptAt).toBe(path.join(userData, unimportable()[0]));
            expect(fs.readFileSync(path.join(userData, unimportable()[0]), 'utf8')).toBe('{broken again');
        });

        test('ends the episode: the copy the marker pointed at is forgotten', () => {
            fs.writeFileSync(legacyFile, '{broken');
            loadFresh();
            settings.loadSettings();
            fs.writeFileSync(
                markerFile,
                JSON.stringify({ importedAt: '2026-10-01T00:00:00.000Z', unimportableCopy: '/old/copy' }),
            );

            expect(settings.startFresh()).toBe(true);

            expect(stored(markerFile)).not.toHaveProperty('unimportableCopy');
        });

        test('says nothing was kept when there was no settings.json', () => {
            loadFresh();

            expect(settings.startFreshDetailed()).toEqual({ ok: true, keptAt: null });
            expect(settings.startFresh()).toBe(true);
            expect(fs.existsSync(path.join(userData, 'settings.json.original'))).toBe(false);
        });
    });

    describe('a restore that could not be tried just now', () => {
        // The mirror has written; then the configuration alone is damaged (cut off, with its sign-in in it): settings.json
        // is the good copy to restore from.
        const damagedConfig = () => {
            signedIn();
            fs.writeFileSync(configFile, '{"app":{"theme":"dark"},"auth":{"token":"tok-1","apiHeaders":{},"last');
        };
        const clockAt = (now: number) => jest.spyOn(Date, 'now').mockReturnValue(now);
        const unimportable = () =>
            fs.readdirSync(userData).filter((name) => name.startsWith('settings.json.unimportable-'));

        // Loads the app with the import lock busy until `lock.busy` is cleared.
        const busyLock = (setup?: () => void) => {
            const lock = { busy: true, tries: 0 };
            loadFresh(() => {
                const actual =
                    jest.requireActual<typeof import('../../../src/ts/lockWait')>('../../../src/ts/lockWait');
                jest.doMock('../../../src/ts/lockWait', () => ({
                    acquireWithin: (...args: Parameters<typeof actual.acquireWithin>) => {
                        lock.tries++;
                        return lock.busy ? 'busy' : actual.acquireWithin(...args);
                    },
                }));
                setup?.();
            });
            return lock;
        };

        // The sign-out is made at a moment the lock is free (the marker is changed under it); the restore still waits.
        const signOutWhileWaiting = (lock: { busy: boolean }): boolean => {
            lock.busy = false;
            const made = settings.setSetting('token', '');
            lock.busy = true;
            return made;
        };

        test('while it waits, the notice is the retrying one: the damaged copy named, Retry only, and nothing overwritten', () => {
            damagedConfig();
            const mirror = fs.readFileSync(legacyFile, 'utf8');
            busyLock();
            clockAt(1_000_000);

            settings.loadSettings();

            expect(settings.getSettingsRecovery()).toEqual({
                code: 'settings-import-retrying',
                path: legacyFile,
                blocking: true,
                damagedAt: expect.stringMatching(/config\.json\.corrupt-/),
            });
            expect(fs.readFileSync(legacyFile, 'utf8')).toBe(mirror);
        });

        test("Retry after a busy first restore ends the episode as the automatic path does: restored, and an older build's sign-out is adopted again", () => {
            damagedConfig();
            const lock = busyLock();
            clockAt(1_000_000);
            settings.loadSettings();
            expect(settings.getSettingsRecovery()).toMatchObject({ code: 'settings-import-retrying' });

            lock.busy = false;
            expect(settings.retryImport()).toBe(true);

            expect(settings.getSettingsRecovery()).toMatchObject({ code: 'settings-restored', blocking: false });
            expect(settings.loadSettings().auth.token).toBe('tok-1');
            // An older build signs out in settings.json; the next save takes it over, as it does after any restore.
            olderBuildChanges((file) => ({ ...file, token: '', apiHeaders: {} }));
            expect(settings.setSetting('theme', 'light')).toBe(true);
            expect(settings.loadSettings().auth.token).toBe('');
            expect(stored(legacyFile)).toMatchObject({ theme: 'light', token: '' });
        });

        test('a retried restore that finds the configuration restored by another process counts as restored, like the first try', () => {
            damagedConfig();
            let storageApi!: typeof import('../../../src/ts/settings/storage');
            const lock = busyLock(() => {
                storageApi =
                    require('../../../src/ts/settings/storage') as typeof import('../../../src/ts/settings/storage');
            });
            clockAt(1_000_000);
            settings.loadSettings();
            expect(settings.getSettingsRecovery()).toMatchObject({ code: 'settings-import-retrying' });

            // Another process restores it meanwhile; this read still found no configuration, and the import under the
            // lock finds it there.
            lock.busy = false;
            fs.writeFileSync(configFile, JSON.stringify({ version: 2, app: { theme: 'dark' }, auth: AUTH }));
            jest.spyOn(storageApi.storage, 'readRaw').mockReturnValueOnce(null);
            clockAt(1_000_000 + 5000);
            settings.loadSettings();

            expect(settings.getSettingsRecovery()).toMatchObject({ code: 'settings-restored', blocking: false });
        });

        test('a restore that keeps failing for a reason that should pass is given up after many tries: settings-corrupt, saves allowed', () => {
            damagedConfig();
            busyLock();
            let now = 1_000_000;
            clockAt(now);
            const seen = new Set<string>();
            for (let attempt = 0; attempt < 12; attempt++) {
                settings.loadSettings();
                seen.add(`${settings.getSettingsRecovery()?.code}`);
                now += 6 * 60 * 1000;
                clockAt(now);
            }

            expect([...seen]).toEqual(['settings-import-retrying', 'settings-corrupt']);
            expect(settings.getSettingsRecovery()).toMatchObject({ code: 'settings-corrupt', blocking: false });
            expect(settings.setSetting('theme', 'light')).toBe(true);
        });

        test('a settings.json that cannot be read for good (no permission) behind a damaged configuration is settled at once: settings-corrupt, saves allowed', () => {
            damagedConfig();
            loadFresh();
            const real = fs.readFileSync;
            jest.spyOn(fs, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
                if (file === legacyFile) throw Object.assign(new Error('EACCES: denied'), { code: 'EACCES' });
                return (real as (...args: unknown[]) => unknown)(file, ...rest);
            }) as typeof fs.readFileSync);

            settings.loadSettings();

            expect(settings.getSettingsRecovery()).toMatchObject({ code: 'settings-corrupt', blocking: false });
            expect(settings.setSetting('theme', 'light')).toBe(true);
            // It cannot be kept as a copy either, so it is not written over.
            expect(cat.warning).toHaveBeenCalledWith(expect.stringContaining('could not be set aside'));
            jest.restoreAllMocks();
            expect(stored(legacyFile)).toMatchObject({ theme: 'dark', token: 'tok-1' });
        });

        test('a settings.json that cannot be looked at when the first save would keep it (a value that carries no message) is not written over', () => {
            damagedConfig();
            fs.writeFileSync(legacyFile, '{broken');
            let storageApi!: typeof import('../../../src/ts/settings/storage');
            loadFresh(() => {
                storageApi =
                    require('../../../src/ts/settings/storage') as typeof import('../../../src/ts/settings/storage');
            });
            settings.loadSettings();
            expect(settings.getSettingsRecovery()).toMatchObject({ code: 'settings-corrupt' });
            jest.spyOn(storageApi.legacyStorage, 'readRaw').mockImplementation(() => {
                throw 'weird';
            });

            expect(settings.setSetting('theme', 'light')).toBe(true);

            expect(cat.warning).toHaveBeenCalledWith(expect.stringContaining('unknown error'));
            jest.restoreAllMocks();
            expect(fs.readFileSync(legacyFile, 'utf8')).toBe('{broken');
        });

        test('with a window listening, the retry is made by itself once the wait is over, and the window is told', () => {
            damagedConfig();
            const lock = busyLock();
            const heard = jest.fn();
            settings.onSettingsRecoveryChange(heard);
            const timers: Array<{ run: () => void; delay: number }> = [];
            jest.spyOn(global, 'setTimeout').mockImplementation(((run: () => void, delay: number) => {
                timers.push({ run, delay });
                return { unref: () => undefined } as unknown as NodeJS.Timeout;
            }) as unknown as typeof setTimeout);
            clockAt(1_000_000);

            settings.loadSettings();
            expect(timers).toHaveLength(1);
            expect(timers[0].delay).toBeGreaterThanOrEqual(1000);

            lock.busy = false;
            clockAt(1_000_000 + 5000);
            timers[0].run();

            expect(settings.getSettingsRecovery()).toMatchObject({ code: 'settings-restored' });
            expect(heard).not.toHaveBeenCalled();
            return Promise.resolve().then(() => expect(heard).toHaveBeenCalled());
        });

        test.each([
            ['an error', new Error('disk gone'), 'disk gone'],
            ['a value that carries no message', 'weird', 'unknown error'],
        ])(
            'a retry that throws %s is logged and does not leave the timer: it would end the main process',
            (_name, thrown, said) => {
                damagedConfig();
                busyLock();
                settings.onSettingsRecoveryChange(jest.fn());
                const timers: Array<{ run: () => void }> = [];
                jest.spyOn(global, 'setTimeout').mockImplementation(((run: () => void) => {
                    timers.push({ run });
                    return { unref: () => undefined } as unknown as NodeJS.Timeout;
                }) as unknown as typeof setTimeout);
                clockAt(1_000_000);
                settings.loadSettings();
                expect(timers).toHaveLength(1);
                // The read that follows the wait throws (the clock is the first thing it asks).
                jest.spyOn(Date, 'now').mockImplementation(() => {
                    throw thrown;
                });

                expect(() => timers[0].run()).not.toThrow();

                expect(cat.error).toHaveBeenCalledWith(
                    expect.stringContaining(`retry of the settings import failed: ${said}`),
                );
            },
        );

        test('with nobody listening, no timer is set: the next read does it', () => {
            damagedConfig();
            busyLock();
            const timer = jest.spyOn(global, 'setTimeout');
            clockAt(1_000_000);

            settings.loadSettings();

            expect(timer).not.toHaveBeenCalled();
        });

        test('an owed sign-out survives the process: it is recorded, and the next process applies it when its restore lands, in the configuration, the mirror and the copies kept', () => {
            damagedConfig();
            fs.writeFileSync(setAside('settings.json.original'), JSON.stringify({ theme: 'dark', token: 'tok-1' }));
            const lock = busyLock();
            clockAt(1_000_000);
            settings.loadSettings();

            expect(signOutWhileWaiting(lock)).toBe(true);

            expect(settings.isSignOutOwed()).toBe(true);
            // It names the sign-in it signs out by fingerprint, never by value.
            expect(stored(markerFile).signOutOwed).toEqual({
                id: expect.any(String),
                at: expect.any(String),
                fingerprints: [expect.stringMatching(/^[0-9a-f]+(\.[0-9a-f]+){3}$/)],
            });
            expect(fs.readFileSync(markerFile, 'utf8')).not.toContain('tok-1');
            // The process ends. The next one restores, and the sign-out holds.
            lock.busy = false;
            loadFresh();
            const loaded = settings.loadSettings();

            expect(loaded.auth).toMatchObject({ token: '', apiHeaders: {} });
            expect(stored(configFile).auth).toMatchObject({ token: '', apiHeaders: {} });
            expect(stored(legacyFile)).toMatchObject({ token: '' });
            expect(stored(setAside('settings.json.original'))).toMatchObject({ token: '' });
            expect(stored(markerFile)).not.toHaveProperty('signOutOwed');
            expect(settings.isSignOutOwed()).toBe(false);
        });

        // Every file of the data folder that is not the marker, with what it holds: none may hold a sign-in after a logout,
        // except the damaged configuration, which does not parse and so cannot be rewritten (see the test of its notice).
        const filesHolding = (needle: string) =>
            fs
                .readdirSync(userData)
                .filter(
                    (name) =>
                        name !== 'v2-import.json' &&
                        !name.startsWith('config.json.corrupt-') &&
                        fs.statSync(path.join(userData, name)).isFile(),
                )
                .filter((name) => fs.readFileSync(path.join(userData, name), 'utf8').includes(needle));

        describe('an owed sign-out when the episode ends in defaults', () => {
            const arrangeOwed = () => {
                damagedConfig();
                fs.writeFileSync(setAside('settings.json.original'), JSON.stringify({ theme: 'dark', token: 'tok-1' }));
                const lock = busyLock();
                clockAt(1_000_000);
                settings.loadSettings();
                expect(signOutWhileWaiting(lock)).toBe(true);
                return lock;
            };

            test('given up after the wait: no copy keeps the sign-in once settings.json is set aside by the first save, and the notice stops saying it does', () => {
                const lock = arrangeOwed();
                clockAt(1_000_000 + 511_000);

                // The restore is given up (settled as unusable), and defaults are in use.
                expect(settings.retryImport()).toBe(false);
                expect(settings.getSettingsRecovery()).toMatchObject({ code: 'settings-corrupt' });
                lock.busy = false;
                settings.loadSettings();
                // The first save sets settings.json (which holds the login) aside as a copy, and mirrors over it.
                expect(settings.setSetting('theme', 'light')).toBe(true);
                settings.loadSettings();

                expect(filesHolding('tok-1')).toEqual([]);
                expect(settings.isSignOutOwed()).toBe(false);
                expect(settings.getSettingsRecovery()).toMatchObject({ code: 'settings-corrupt' });
            });

            test('a sign-in made after the give-up is not undone by the sign-out that was owed, and the copies still lose the old one', () => {
                const lock = arrangeOwed();
                clockAt(1_000_000 + 511_000);
                expect(settings.retryImport()).toBe(false);
                lock.busy = false;
                settings.loadSettings();

                expect(settings.setSetting('token', 'tok-new')).toBe(true);

                expect(settings.loadSettings().auth.token).toBe('tok-new');
                expect(stored(markerFile)).not.toHaveProperty('signOutOwed');
                expect(filesHolding('tok-1')).toEqual([]);
                loadFresh();
                expect(settings.loadSettings().auth.token).toBe('tok-new');
            });

            test('while the copy to come is not made the record stays, and a login made meanwhile is stored and stays; the copy is cleared as it is set aside', () => {
                const lock = arrangeOwed();
                clockAt(1_000_000 + 511_000);
                expect(settings.retryImport()).toBe(false);
                settings.loadSettings();
                expect(stored(markerFile)).toHaveProperty('signOutOwed');

                // The record names the old sign-in only: the new token is not signed out by it, whatever the lock does.
                expect(settings.setSetting('token', 'tok-new')).toBe(true);
                lock.busy = false;
                expect(settings.setSetting('theme', 'light')).toBe(true);

                expect(filesHolding('tok-1')).toEqual([]);
                expect(settings.loadSettings().auth.token).toBe('tok-new');
                loadFresh();
                expect(settings.loadSettings().auth.token).toBe('tok-new');
                expect(stored(markerFile)).not.toHaveProperty('signOutOwed');
            });

            test('with the lock still held at the set-aside, the record that stayed has the copy cleared as it is made', () => {
                const lock = arrangeOwed();
                clockAt(1_000_000 + 511_000);
                expect(settings.retryImport()).toBe(false);
                settings.loadSettings();
                expect(lock.busy).toBe(true);

                // Another process still holds the lock: the first save cannot mirror (nor make the pending flag), but it
                // does set settings.json aside, and the record on file has that copy cleared.
                expect(settings.setSetting('theme', 'light')).toBe(true);

                expect(filesHolding('tok-1')).toEqual(['settings.json']);
                expect(
                    fs.readdirSync(userData).filter((name) => name.startsWith('settings.json.unimportable-')),
                ).toHaveLength(1);
            });

            test('a Start fresh that does not happen leaves no promise to set settings.json aside', () => {
                fs.writeFileSync(legacyFile, '{broken');
                loadFresh();
                settings.loadSettings();
                const real = fs.readFileSync;
                jest.spyOn(fs, 'readFileSync').mockImplementation(((
                    file: fs.PathOrFileDescriptor,
                    ...rest: unknown[]
                ) => {
                    if (file === legacyFile) throw Object.assign(new Error('EACCES: denied'), { code: 'EACCES' });
                    return (real as (...args: unknown[]) => unknown)(file, ...rest);
                }) as typeof fs.readFileSync);
                // The record is made, and then the configuration cannot be written.
                failingWrites(CONFIG_TMP);

                expect(settings.startFresh()).toBe(false);

                jest.restoreAllMocks();
                expect(fs.existsSync(configFile)).toBe(false);
                expect(stored(markerFile)).not.toHaveProperty('legacyAsideOwed');
            });

            test('the same after Start fresh over a settings.json that could not be read: the login made meanwhile stays', () => {
                const lock = arrangeOwed();
                lock.busy = false;
                const real = fs.readFileSync;
                jest.spyOn(fs, 'readFileSync').mockImplementation(((
                    file: fs.PathOrFileDescriptor,
                    ...rest: unknown[]
                ) => {
                    if (file === legacyFile) throw Object.assign(new Error('EACCES: denied'), { code: 'EACCES' });
                    return (real as (...args: unknown[]) => unknown)(file, ...rest);
                }) as typeof fs.readFileSync);
                expect(settings.startFresh()).toBe(true);
                settings.loadSettings();
                jest.restoreAllMocks();
                expect(stored(markerFile)).toMatchObject({ legacyAsideOwed: expect.any(String) });

                // It can be read now; the login comes first, and the save sets it aside.
                expect(settings.setSetting('token', 'tok-new')).toBe(true);

                expect(settings.loadSettings().auth.token).toBe('tok-new');
                expect(filesHolding('tok-1')).toEqual([]);
                expect(stored(markerFile)).not.toHaveProperty('legacyAsideOwed');
                expect(stored(markerFile)).not.toHaveProperty('signOutOwed');
            });

            test('across processes: the next process applies the record when it starts, and a login after that stays', () => {
                const lock = arrangeOwed();
                lock.busy = false;

                loadFresh();
                expect(settings.loadSettings().auth.token).toBe('');
                expect(settings.setSetting('token', 'tok-new')).toBe(true);
                loadFresh();

                expect(settings.loadSettings().auth.token).toBe('tok-new');
                expect(stored(markerFile)).not.toHaveProperty('signOutOwed');
            });

            test('a login made after the restore stays: the record names the sign-in it signed out, and a new token is not that one, in whichever process the settings then come through', () => {
                damagedConfig();
                const lock = busyLock();
                clockAt(1_000_000);
                settings.loadSettings();
                expect(signOutWhileWaiting(lock)).toBe(true);
                expect(settings.isSignOutOwed()).toBe(true);
                lock.busy = false;
                // (Retry restores the settings, with the login they held; the owed sign-out is applied by the next read.)
                expect(settings.retryImport()).toBe(true);
                expect(settings.setSetting('token', 'tok-new')).toBe(true);

                expect(settings.isSignOutOwed()).toBe(false);
                loadFresh();
                expect(settings.loadSettings().auth.token).toBe('tok-new');
            });

            test('the copies are not scrubbed again at every start while nothing changed', () => {
                const lock = arrangeOwed();
                lock.busy = false;
                loadFresh();
                settings.loadSettings();
                const original = setAside('settings.json.original');
                expect(stored(original)).toMatchObject({ token: '' });
                expect(stored(markerFile)).not.toHaveProperty('signOutScrubPending');
                const rewrittenAt = fs.statSync(original).mtimeMs;

                loadFresh();
                settings.loadSettings();
                loadFresh();
                settings.loadSettings();

                expect(fs.statSync(original).mtimeMs).toBe(rewrittenAt);
                expect(stored(markerFile)).not.toHaveProperty('signOutScrubPending');
            });

            test('Start fresh (also with --force): the copy it keeps holds no sign-in', () => {
                const lock = arrangeOwed();
                lock.busy = false;

                expect(settings.startFresh()).toBe(true);
                settings.loadSettings();

                expect(filesHolding('tok-1')).toEqual([]);
                expect(settings.isSignOutOwed()).toBe(false);
            });

            test("another process's fresh start: the next process clears every copy and the record", () => {
                const lock = arrangeOwed();
                // Another process starts fresh meanwhile: defaults, and its own copy of settings.json.
                lock.busy = false;
                fs.writeFileSync(
                    configFile,
                    JSON.stringify({ version: 2, app: { theme: 'light' }, auth: { token: '', apiHeaders: {} } }),
                );
                fs.writeFileSync(markerFile, JSON.stringify({ ...stored(markerFile), configFrom: 'fresh' }));
                fs.writeFileSync(
                    setAside('settings.json.unimportable-2026-10-16T08-00-00-000Z'),
                    JSON.stringify({ token: 'tok-1' }),
                );

                loadFresh();
                settings.loadSettings();

                expect(stored(setAside('settings.json.unimportable-2026-10-16T08-00-00-000Z'))).toMatchObject({
                    token: '',
                });
                expect(stored(markerFile)).not.toHaveProperty('signOutOwed');
            });

            test('a logout cannot take the sign-in out of the damaged configuration, which does not parse: it stays as it was', () => {
                damagedConfig();
                const lock = busyLock();
                clockAt(1_000_000);
                settings.loadSettings();
                const damaged = fs.readdirSync(userData).filter((name) => name.startsWith('config.json.corrupt-'));
                expect(damaged).toHaveLength(1);
                const before = fs.readFileSync(setAside(damaged[0]), 'utf8');

                expect(signOutWhileWaiting(lock)).toBe(true);
                lock.busy = false;
                expect(settings.retryImport()).toBe(true);
                settings.loadSettings();

                // Every readable copy lost the token; the damaged one is untouched and still holds it.
                expect(filesHolding('tok-1')).toEqual([]);
                expect(fs.readFileSync(setAside(damaged[0]), 'utf8')).toBe(before);
                expect(before).toContain('tok-1');
                expect(settings.getSettingsRecovery()).toMatchObject({ code: 'settings-restored' });
                expect(settings.getSettingsRecovery()).not.toHaveProperty('signInKept');
            });
        });

        describe('an owed sign-out signs out the sign-in it names, whatever order things land in', () => {
            test('a logout, a login refused while the restore waits, and the restore landing: the token stays blank', () => {
                damagedConfig();
                const lock = busyLock();
                clockAt(1_000_000);
                settings.loadSettings();
                expect(signOutWhileWaiting(lock)).toBe(true);

                // The login is refused (the stored settings are not in use), so it leaves nothing behind that could undo the logout.
                expect(settings.setSetting('token', 'tok-2')).toBe(false);
                lock.busy = false;
                expect(settings.retryImport()).toBe(true);

                expect(settings.loadSettings().auth).toMatchObject({ token: '', apiHeaders: {} });
                expect(stored(configFile).auth).toMatchObject({ token: '', apiHeaders: {} });
                expect(stored(legacyFile)).toMatchObject({ token: '' });
                loadFresh();
                expect(settings.loadSettings().auth.token).toBe('');
            });

            test("the sign-in named is the one settings.json holds even when the marker recorded none, and the mirror's when settings.json holds none", () => {
                damagedConfig();
                const withoutFingerprints = (({ signInPending: _p, signInConfirmed: _c, ...rest }) => rest)(
                    stored(markerFile),
                );
                fs.writeFileSync(markerFile, JSON.stringify(withoutFingerprints));
                const lock = busyLock();
                clockAt(1_000_000);
                settings.loadSettings();

                // Named by what settings.json holds.
                expect(signOutWhileWaiting(lock)).toBe(true);
                expect(stored(markerFile).signOutOwed).toMatchObject({ fingerprints: [expect.any(String)] });
                lock.busy = false;
                expect(settings.retryImport()).toBe(true);
                expect(settings.loadSettings().auth.token).toBe('');
            });

            test("the mirror's fingerprints name the sign-in when settings.json holds no token", () => {
                damagedConfig();
                olderBuildChanges(({ token: _token, ...rest }) => rest);
                const lock = busyLock();
                clockAt(1_000_000);
                settings.loadSettings();

                expect(signOutWhileWaiting(lock)).toBe(true);

                expect(stored(markerFile).signOutOwed).toMatchObject({
                    fingerprints: expect.arrayContaining([expect.any(String)]),
                });
            });

            test('a logout with no sign-in to name is refused while settings.json cannot be read, and needs no record when it can', () => {
                damagedConfig();
                olderBuildChanges(({ token: _token, ...rest }) => rest);
                const bare = (({ signInPending: _p, signInConfirmed: _c, ...rest }) => rest)(stored(markerFile));
                fs.writeFileSync(markerFile, JSON.stringify(bare));
                const lock = busyLock();
                clockAt(1_000_000);
                settings.loadSettings();
                expect(settings.getSettingsRecovery()).toMatchObject({ code: 'settings-import-retrying' });

                // Not known whether the file the restore waits for holds a sign-in: the logout is not taken for made.
                expect(signOutWhileWaiting(lock)).toBe(false);
                expect(stored(markerFile)).not.toHaveProperty('signOutOwed');
            });

            test('a sign-in that is another (an older build logged in meanwhile) is not the one signed out, in the configuration or in a copy', () => {
                damagedConfig();
                const lock = busyLock();
                clockAt(1_000_000);
                settings.loadSettings();
                expect(signOutWhileWaiting(lock)).toBe(true);
                // The older build's login, in the file the restore reads and in a copy kept.
                olderBuildChanges((file) => ({ ...file, token: 'tok-2' }));
                const copy = setAside('settings.json.unimportable-2026-10-16T08-00-00-000Z');
                fs.writeFileSync(copy, JSON.stringify({ token: 'tok-2' }));
                lock.busy = false;

                loadFresh();
                expect(settings.loadSettings().auth.token).toBe('tok-2');

                expect(stored(copy)).toMatchObject({ token: 'tok-2' });
                expect(stored(markerFile)).not.toHaveProperty('signOutOwed');
                loadFresh();
                expect(settings.loadSettings().auth.token).toBe('tok-2');
            });

            test('a record that is not removed (the marker is held) is not made again later: it applies to nothing once the sign-in is gone', () => {
                damagedConfig();
                const lock = busyLock();
                clockAt(1_000_000);
                settings.loadSettings();
                expect(signOutWhileWaiting(lock)).toBe(true);
                lock.busy = false;
                expect(settings.retryImport()).toBe(true);
                // The restore lands and is signed out, but the record cannot be removed just now.
                lock.busy = true;
                expect(settings.loadSettings().auth.token).toBe('');
                expect(stored(markerFile)).toHaveProperty('signOutOwed');

                // A login after that stays, and the record never signs it out.
                lock.busy = false;
                expect(settings.setSetting('token', 'tok-new')).toBe(true);
                loadFresh();
                expect(settings.loadSettings().auth.token).toBe('tok-new');
                expect(settings.setSetting('theme', 'light')).toBe(true);
                expect(settings.loadSettings().auth.token).toBe('tok-new');
            });

            test('a record older than the copies are kept for is removed even while a settings.json is still to be set aside', () => {
                signedIn();
                const marker = stored(markerFile);
                const record = (at: string) => ({ id: 'r', at, fingerprints: ['0.0.0.0'] });
                fs.writeFileSync(
                    markerFile,
                    JSON.stringify({
                        ...marker,
                        legacyAsideOwed: 'pending-aside',
                        signOutOwed: record(new Date(Date.now() - 20 * 24 * 3600 * 1000).toISOString()),
                    }),
                );
                loadFresh();

                settings.loadSettings();

                expect(stored(markerFile)).not.toHaveProperty('signOutOwed');
            });
        });

        test('the automatic wait after manual Retries is the one they have earned: the next read tries only once it is over', () => {
            damagedConfig();
            const lock = busyLock();
            clockAt(1_000_000);
            settings.loadSettings();
            for (let attempt = 0; attempt < 12; attempt++) settings.retryImport();
            const tries = lock.tries;

            // Inside the wait (five minutes by now): a read takes no lock.
            clockAt(1_000_000 + 4 * 60 * 1000);
            settings.loadSettings();
            expect(lock.tries).toBe(tries);

            clockAt(1_000_000 + 5 * 60 * 1000 + 1);
            settings.loadSettings();
            expect(lock.tries).toBe(tries + 1);
        });

        test('the give-up is at 510 seconds: 509 stays retrying, 511 settles', () => {
            damagedConfig();
            busyLock();
            clockAt(1_000_000);
            settings.loadSettings();

            clockAt(1_000_000 + 509_000);
            expect(settings.retryImport()).toBe(false);
            expect(settings.getSettingsRecovery()).toMatchObject({ code: 'settings-import-retrying' });

            clockAt(1_000_000 + 511_000);
            expect(settings.retryImport()).toBe(false);
            expect(settings.getSettingsRecovery()).toMatchObject({ code: 'settings-corrupt', blocking: false });
        });

        test('a sign-out is refused while another process holds the settings lock: the marker is changed under it', () => {
            damagedConfig();
            busyLock();
            clockAt(1_000_000);
            settings.loadSettings();

            expect(settings.setSetting('token', '')).toBe(false);

            expect(stored(markerFile)).not.toHaveProperty('signOutOwed');
        });

        test('Start fresh over a settings.json that could not be read is refused when the set-aside cannot be recorded: nothing is started', () => {
            fs.writeFileSync(legacyFile, '{broken');
            loadFresh();
            settings.loadSettings();
            const real = fs.readFileSync;
            jest.spyOn(fs, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
                if (file === legacyFile) throw Object.assign(new Error('EACCES: denied'), { code: 'EACCES' });
                return (real as (...args: unknown[]) => unknown)(file, ...rest);
            }) as typeof fs.readFileSync);
            failingWrites(MARKER_TMP);

            expect(settings.startFresh()).toBe(false);

            jest.restoreAllMocks();
            expect(fs.existsSync(configFile)).toBe(false);
            expect(settings.getSettingsRecovery()).toMatchObject({ blocking: true });
        });

        test('a sign-out that cannot be recorded is refused, not taken for made', () => {
            damagedConfig();
            busyLock();
            clockAt(1_000_000);
            settings.loadSettings();
            failingWrites(MARKER_TMP);

            expect(settings.setSetting('token', '')).toBe(false);

            jest.restoreAllMocks();
            expect(stored(markerFile)).not.toHaveProperty('signOutOwed');
        });

        test('ten quick manual Retries do not give the restore up: it is the time that does', () => {
            damagedConfig();
            busyLock();
            clockAt(1_000_000);
            settings.loadSettings();

            for (let attempt = 0; attempt < 12; attempt++) expect(settings.retryImport()).toBe(false);

            expect(settings.getSettingsRecovery()).toMatchObject({ code: 'settings-import-retrying', blocking: true });
        });

        test("defaults written by another process's Start fresh, found there at the retry, are not the restore: the copies keep their sign-in", () => {
            damagedConfig();
            fs.writeFileSync(setAside('settings.json.original'), JSON.stringify({ theme: 'dark', token: 'tok-orig' }));
            let storageApi!: typeof import('../../../src/ts/settings/storage');
            const lock = busyLock(() => {
                storageApi =
                    require('../../../src/ts/settings/storage') as typeof import('../../../src/ts/settings/storage');
            });
            clockAt(1_000_000);
            settings.loadSettings();
            expect(settings.getSettingsRecovery()).toMatchObject({ code: 'settings-import-retrying' });

            lock.busy = false;
            fs.writeFileSync(
                configFile,
                JSON.stringify({ version: 2, app: { theme: 'light' }, auth: { token: '', apiHeaders: {} } }),
            );
            fs.writeFileSync(markerFile, JSON.stringify({ ...stored(markerFile), configFrom: 'fresh' }));
            jest.spyOn(storageApi.storage, 'readRaw').mockReturnValueOnce(null);
            clockAt(1_000_000 + 5000);
            settings.loadSettings();

            expect(settings.getSettingsRecovery()).toMatchObject({ code: 'settings-corrupt', blocking: false });
            expect(stored(setAside('settings.json.original'))).toMatchObject({ token: 'tok-orig' });
        });

        test("Start fresh that finds the defaults of another process's Start fresh there does not call them the restore either", () => {
            damagedConfig();
            fs.writeFileSync(setAside('settings.json.original'), JSON.stringify({ theme: 'dark', token: 'tok-orig' }));
            const lock = busyLock();
            clockAt(1_000_000);
            settings.loadSettings();
            lock.busy = false;
            fs.writeFileSync(
                configFile,
                JSON.stringify({ version: 2, app: { theme: 'light' }, auth: { token: '', apiHeaders: {} } }),
            );
            fs.writeFileSync(markerFile, JSON.stringify({ ...stored(markerFile), configFrom: 'fresh' }));

            expect(settings.startFreshDetailed()).toMatchObject({ ok: true, adopted: true });

            expect(settings.getSettingsRecovery()).toMatchObject({ code: 'settings-corrupt', blocking: false });
            expect(stored(setAside('settings.json.original'))).toMatchObject({ token: 'tok-orig' });
        });

        test('the same at the first try: defaults another process wrote while the damaged configuration was set aside are not a restore', () => {
            damagedConfig();
            fs.writeFileSync(setAside('settings.json.original'), JSON.stringify({ theme: 'dark', token: 'tok-orig' }));
            let storageApi!: typeof import('../../../src/ts/settings/storage');
            loadFresh(() => {
                storageApi =
                    require('../../../src/ts/settings/storage') as typeof import('../../../src/ts/settings/storage');
            });
            const real = storageApi.storage.quarantineRaw.bind(storageApi.storage);
            jest.spyOn(storageApi.storage, 'quarantineRaw').mockImplementation((raw) => {
                const moved = real(raw);
                fs.writeFileSync(
                    configFile,
                    JSON.stringify({ version: 2, app: { theme: 'light' }, auth: { token: '', apiHeaders: {} } }),
                );
                fs.writeFileSync(markerFile, JSON.stringify({ ...stored(markerFile), configFrom: 'fresh' }));
                return moved;
            });

            settings.loadSettings();

            expect(settings.getSettingsRecovery()).toMatchObject({ code: 'settings-corrupt', blocking: false });
            expect(stored(setAside('settings.json.original'))).toMatchObject({ token: 'tok-orig' });
        });

        test('a sign-out made while the restore waits holds when the settings come through', () => {
            damagedConfig();
            const lock = busyLock();
            clockAt(1_000_000);
            settings.loadSettings();
            expect(settings.getSettingsRecovery()).toMatchObject({ code: 'settings-import-retrying' });

            // The user logs out; the blocked settings take no write, but the sign-out is kept.
            expect(signOutWhileWaiting(lock)).toBe(true);
            lock.busy = false;
            clockAt(1_000_000 + 5000);

            expect(settings.loadSettings().auth.token).toBe('');
            expect(stored(configFile).auth).toMatchObject({ token: '' });
        });

        test('a sign-out that cannot be applied yet when the settings come through stays owed until it can', () => {
            damagedConfig();
            const lock = busyLock();
            clockAt(1_000_000);
            settings.loadSettings();
            expect(signOutWhileWaiting(lock)).toBe(true);
            lock.busy = false;
            clockAt(1_000_000 + 5000);
            // The restore is written; the sign-out written over it is refused.
            const failing = failingWrites(CONFIG_TMP, 1);

            expect(settings.loadSettings().auth.token).toBe('tok-1');
            expect(stored(configFile).auth).toMatchObject({ token: 'tok-1' });

            failing.failing = false;
            expect(settings.loadSettings().auth.token).toBe('');
            expect(stored(configFile).auth).toMatchObject({ token: '' });
        });

        test('a sign-out made while the restore waits, when the settings that come through hold none, has nothing to apply', () => {
            signedIn();
            olderBuildChanges((file) => ({ ...file, token: '', apiHeaders: {} }));
            fs.writeFileSync(configFile, '{"app":{"theme":');
            const lock = busyLock();
            clockAt(1_000_000);
            settings.loadSettings();
            expect(signOutWhileWaiting(lock)).toBe(true);
            lock.busy = false;
            clockAt(1_000_000 + 5000);

            expect(settings.loadSettings().auth.token).toBe('');
            expect(settings.getSettingsRecovery()).toMatchObject({ code: 'settings-restored' });
        });

        test('Start fresh over a configuration that is not readable as settings changes nothing of the episode', () => {
            damagedConfig();
            fs.writeFileSync(legacyFile, '{broken');
            loadFresh();
            settings.loadSettings();
            expect(settings.getSettingsRecovery()).toMatchObject({ code: 'settings-corrupt' });
            fs.writeFileSync(configFile, 'garbage');

            expect(settings.startFresh()).toBe(true);

            expect(settings.getSettingsRecovery()).toMatchObject({ code: 'settings-corrupt' });
        });

        test('a restore from a settings.json that holds a sign-out an older build made clears the sign-in out of the copies kept', () => {
            signedIn();
            // The user\'s own file, kept as the original copy, holds the login.
            fs.writeFileSync(setAside('settings.json.original'), JSON.stringify({ theme: 'dark', token: 'tok-orig' }));
            olderBuildChanges((file) => ({ ...file, token: '', apiHeaders: {} }));
            fs.writeFileSync(configFile, '{"app":{"theme":');
            loadFresh();

            settings.loadSettings();

            expect(settings.getSettingsRecovery()).toMatchObject({ code: 'settings-restored' });
            expect(stored(setAside('settings.json.original'))).toMatchObject({ token: '' });
        });

        test('the import lock busy once: nothing is saved over settings.json meanwhile, and the next read restores it, signed in', () => {
            damagedConfig();
            const mirror = fs.readFileSync(legacyFile, 'utf8');
            let busy = true;
            loadFresh(() => {
                const actual =
                    jest.requireActual<typeof import('../../../src/ts/lockWait')>('../../../src/ts/lockWait');
                jest.doMock('../../../src/ts/lockWait', () => ({
                    acquireWithin: (...args: Parameters<typeof actual.acquireWithin>) =>
                        busy ? 'busy' : actual.acquireWithin(...args),
                }));
            });
            clockAt(1_000_000);

            // The first read cannot restore: defaults, saving refused, and nothing is written over the good file.
            expect(settings.loadSettings()).toEqual(settings.getDefaultSettings());
            expect(settings.getSettingsRecovery()).toMatchObject({ code: 'settings-import-retrying', blocking: true });
            expect(settings.setSetting('theme', 'light')).toBe(false);
            expect(fs.readFileSync(legacyFile, 'utf8')).toBe(mirror);
            expect(unimportable()).toEqual([]);
            // Reads inside the retry delay answer the same without trying the lock again.
            expect(settings.loadSettings()).toEqual(settings.getDefaultSettings());

            busy = false;
            clockAt(1_000_000 + 5000);
            const restored = settings.loadSettings();

            expect(restored.auth.token).toBe('tok-1');
            expect(restored.app.theme).toBe('dark');
            expect(settings.getSettingsRecovery()).toMatchObject({ code: 'settings-restored', blocking: false });
            expect(fs.readFileSync(legacyFile, 'utf8')).toBe(mirror);
            expect(unimportable()).toEqual([]);
            expect(settings.setSetting('theme', 'light')).toBe(true);
        });

        test('a read of settings.json that failed once is the same: tried again, not taken for an unusable file', () => {
            damagedConfig();
            const mirror = fs.readFileSync(legacyFile, 'utf8');
            loadFresh();
            const real = fs.readFileSync;
            let failing = true;
            jest.spyOn(fs, 'readFileSync').mockImplementation(((file: fs.PathLike | number, ...rest: unknown[]) => {
                if (failing && String(file) === legacyFile) throw new Error('EBUSY');
                return (real as (...args: unknown[]) => unknown)(file, ...rest);
            }) as typeof fs.readFileSync);
            clockAt(2_000_000);

            settings.loadSettings();
            expect(settings.getSettingsRecovery()).toMatchObject({ code: 'settings-import-retrying', blocking: true });
            expect(settings.setSetting('theme', 'light')).toBe(false);
            // Said once, however often it is read.
            settings.loadSettings();
            expect(cat.error.mock.calls.filter(([message]) => String(message).includes('EBUSY'))).toHaveLength(1);

            failing = false;
            clockAt(2_000_000 + 5000);

            expect(settings.loadSettings().auth.token).toBe('tok-1');
            expect(fs.readFileSync(legacyFile, 'utf8')).toBe(mirror);
            expect(unimportable()).toEqual([]);
        });

        test('busy once, then settings.json found damaged: settled like a first-try failure (settings-corrupt, saves allowed, set aside at the first save), not a blocked import', () => {
            damagedConfig();
            let busy = true;
            loadFresh(() => {
                const actual =
                    jest.requireActual<typeof import('../../../src/ts/lockWait')>('../../../src/ts/lockWait');
                jest.doMock('../../../src/ts/lockWait', () => ({
                    acquireWithin: (...args: Parameters<typeof actual.acquireWithin>) =>
                        busy ? 'busy' : actual.acquireWithin(...args),
                }));
            });
            clockAt(1_000_000);
            settings.loadSettings();
            expect(settings.getSettingsRecovery()).toMatchObject({ code: 'settings-import-retrying', blocking: true });
            // Meanwhile the good copy is damaged (by hand, an older build, a disk fault).
            fs.writeFileSync(legacyFile, '{broken');
            busy = false;
            clockAt(1_000_000 + 5000);

            expect(settings.loadSettings()).toEqual(settings.getDefaultSettings());

            expect(settings.getSettingsRecovery()).toMatchObject({ code: 'settings-corrupt', blocking: false });
            // Said as the first try says it: once, as a warning.
            const noMirror = () =>
                cat.warning.mock.calls.filter(([message]) => String(message).includes('no usable settings.json'));
            expect(noMirror()).toHaveLength(1);
            settings.loadSettings();
            expect(noMirror()).toHaveLength(1);
            expect(settings.setSetting('theme', 'light')).toBe(true);
            expect(unimportable()).toHaveLength(1);
            expect(fs.readFileSync(path.join(userData, unimportable()[0]), 'utf8')).toBe('{broken');
            expect(stored(legacyFile)).toMatchObject({ theme: 'light' });
            // And it stays one state however often it is read.
            expect(settings.getSettingsRecovery()).toMatchObject({ code: 'settings-corrupt' });
        });

        test('a configuration that goes missing later, with an unimportable settings.json, is a blocked import: only a restore still to be retried settles', () => {
            signedIn();
            fs.writeFileSync(configFile, '{"app":{"theme":');
            fs.writeFileSync(legacyFile, '{broken');
            loadFresh();
            // The episode is settled first (no usable settings.json), then the user fixes the file and retries.
            settings.loadSettings();
            expect(settings.getSettingsRecovery()).toMatchObject({ code: 'settings-corrupt', blocking: false });
            fs.writeFileSync(legacyFile, JSON.stringify({ theme: 'dark', token: 'tok-fixed' }));
            expect(settings.retryImport()).toBe(true);
            expect(settings.loadSettings().auth.token).toBe('tok-fixed');

            // Later, in the same process, the configuration is gone and settings.json is damaged again.
            fs.rmSync(configFile);
            fs.writeFileSync(legacyFile, '{broken');
            settings.loadSettings();

            expect(settings.getSettingsRecovery()).toMatchObject({ code: 'settings-import-failed', blocking: true });
            expect(settings.setSetting('theme', 'light')).toBe(false);
        });

        test('the block a read clears is announced, so that the notice shown for it is read again and is the restored one', async () => {
            damagedConfig();
            let busy = true;
            loadFresh(() => {
                const actual =
                    jest.requireActual<typeof import('../../../src/ts/lockWait')>('../../../src/ts/lockWait');
                jest.doMock('../../../src/ts/lockWait', () => ({
                    acquireWithin: (...args: Parameters<typeof actual.acquireWithin>) =>
                        busy ? 'busy' : actual.acquireWithin(...args),
                }));
            });
            const heard = jest.fn();
            settings.onSettingsRecoveryChange(heard);
            clockAt(1_000_000);
            settings.loadSettings();
            expect(settings.getSettingsRecovery()).toMatchObject({ code: 'settings-import-retrying', blocking: true });
            // (A read that only stays blocked says nothing.)
            settings.loadSettings();
            await Promise.resolve();
            expect(heard).not.toHaveBeenCalled();

            busy = false;
            clockAt(1_000_000 + 5000);
            settings.loadSettings();

            // Not inside the read that cleared it, but right after.
            expect(heard).not.toHaveBeenCalled();
            await Promise.resolve();
            expect(heard).toHaveBeenCalledTimes(1);
            expect(settings.getSettingsRecovery()).toMatchObject({ code: 'settings-restored', blocking: false });
            // And a read that finds nothing blocked says nothing.
            settings.loadSettings();
            await Promise.resolve();
            expect(heard).toHaveBeenCalledTimes(1);
        });

        test('a write that always fails is tried a bounded number of times, said once, and never flaps the state', () => {
            signedIn();
            fs.rmSync(configFile);
            fs.rmSync(markerFile);
            // settings.json is importable (the user\'s file from before), and the configuration can never be written.
            fs.writeFileSync(legacyFile, JSON.stringify({ theme: 'dark', token: 'tok-1' }));
            loadFresh();
            const failing = failingWrites(CONFIG_TMP);
            let now = 1_000_000;
            const clock = clockAt(now);

            const seen = new Set<string>();
            for (let second = 0; second < 600; second++) {
                now += 1000;
                clock.mockReturnValue(now);
                settings.loadSettings();
                seen.add(`${settings.getSettingsRecovery()?.code}`);
            }

            // (Every try opens the temporary file once: 1 s, 2 s, 4 s ... up to five minutes apart.)
            expect(failing.seen).toBeLessThanOrEqual(12);
            expect(failing.seen).toBeGreaterThanOrEqual(5);
            expect([...seen]).toEqual(['settings-import-retrying']);
            expect(
                cat.error.mock.calls.filter(([message]) => String(message).includes('Settings cannot be used')),
            ).toHaveLength(1);
            expect(fs.readFileSync(legacyFile, 'utf8')).toContain('tok-1');
        });

        test('a settings.json that cannot be imported at all is still settled: not tried again, and the notice is the corrupt one', () => {
            damagedConfig();
            fs.writeFileSync(legacyFile, '{broken');
            loadFresh();
            clockAt(3_000_000);

            settings.loadSettings();
            settings.loadSettings();
            clockAt(3_000_000 + 60_000);
            settings.loadSettings();

            expect(settings.getSettingsRecovery()).toMatchObject({ code: 'settings-corrupt', blocking: false });
            expect(fs.readFileSync(legacyFile, 'utf8')).toBe('{broken');
        });
    });

    describe('the logout scrub of the copies', () => {
        const COPY = 'settings.json.unimportable-2026-10-16T08-00-00-000Z';
        const withCopy = () => {
            signedIn();
            fs.writeFileSync(
                path.join(userData, COPY),
                JSON.stringify({ theme: 'dark', token: 'tok-copy', lastUsername: 'me', chosenPhotosMemberId: 'm-7' }),
            );
        };

        test('does not wait for the mirror: it is done when the mirror cannot run (the settings lock is busy)', () => {
            withCopy();
            loadFresh(() => {
                jest.doMock('../../../src/ts/lockWait', () => ({ acquireWithin: () => 'busy' }));
            });
            settings.loadSettings();

            expect(settings.setSetting('token', '')).toBe(true);

            expect(stored(path.join(userData, COPY))).toEqual({
                theme: 'dark',
                token: '',
                apiHeaders: {},
                lastUsername: '',
                chosenPhotosMemberId: '',
            });
            // (settings.json itself is made again with the next save or start.)
            expect(stored(legacyFile)).toMatchObject({ token: 'tok-1' });
        });

        test('is done for the startup clear of a stored token (Stay Logged In off), and a sign-out saved by a whole-configuration save', () => {
            withCopy();
            loadFresh();
            const config = settings.loadSettings();

            expect(settings.saveSettings({ auth: { ...config.auth, token: '' } })).toBe(true);

            expect(stored(path.join(userData, COPY))).toMatchObject({ token: '' });
        });

        test('is not done for a save that failed', () => {
            withCopy();
            loadFresh();
            settings.loadSettings();
            failingWrites(CONFIG_TMP);

            expect(settings.setSetting('token', '')).toBe(false);

            expect(stored(path.join(userData, COPY))).toMatchObject({ token: 'tok-copy' });
        });

        test('is not carried to a later save: the sign-out of a failed save is not done again by the next one', () => {
            withCopy();
            loadFresh();
            settings.loadSettings();
            const failing = failingWrites(CONFIG_TMP);
            expect(settings.setSetting('token', '')).toBe(false);
            failing.failing = false;

            expect(settings.setSetting('theme', 'light')).toBe(true);

            expect(stored(path.join(userData, COPY))).toMatchObject({ token: 'tok-copy' });
        });

        test('never throws into the logout: a copy that cannot be listed is logged', () => {
            withCopy();
            loadFresh();
            settings.loadSettings();
            jest.spyOn(fs, 'readdirSync').mockImplementation(() => {
                throw new Error('EACCES');
            });

            expect(settings.setSetting('token', '')).toBe(true);
            expect(stored(configFile).auth).toMatchObject({ token: '' });
        });
    });

    describe('a 1.12.2-style logout', () => {
        test('that blanks only the token (the headers stay): only the token is adopted', () => {
            signedIn();
            olderBuildChanges((file) => ({ ...file, token: '' }));

            loadFresh();

            expect(settings.loadSettings().auth).toEqual({ ...AUTH, token: '' });
            expect(stored(legacyFile)).toMatchObject({ token: '', apiHeaders: { 'x-a': 'b' } });
        });
    });

    describe('the settings lock', () => {
        test('a mirror that cannot take it is given up quietly, and the next start makes it', () => {
            signedIn();
            fs.writeFileSync(configFile, JSON.stringify({ ...stored(configFile), app: { theme: 'light' } }));
            const before = fs.readFileSync(legacyFile, 'utf8');
            loadFresh(() => {
                jest.doMock('../../../src/ts/lockWait', () => ({ acquireWithin: () => 'busy' }));
            });

            settings.loadSettings();

            expect(fs.readFileSync(legacyFile, 'utf8')).toBe(before);
            expect(cat.error).not.toHaveBeenCalled();
            expect(cat.warning).not.toHaveBeenCalled();
            expect(cat.debug).toHaveBeenCalledWith(expect.stringContaining('is being changed by another process'));

            jest.dontMock('../../../src/ts/lockWait');
            loadFresh();
            settings.loadSettings();
            expect(stored(legacyFile)).toMatchObject({ theme: 'light' });
        });

        test('a lock that cannot be had at all is the same', () => {
            signedIn();
            fs.writeFileSync(configFile, JSON.stringify({ ...stored(configFile), app: { theme: 'light' } }));
            loadFresh(() => {
                jest.doMock('../../../src/ts/lockWait', () => ({ acquireWithin: () => 'unavailable' }));
            });

            settings.loadSettings();

            expect(stored(legacyFile)).toMatchObject({ theme: 'dark' });
            expect(cat.debug).toHaveBeenCalledWith(expect.stringContaining('is being changed by another process'));
        });

        test('is held across the compare and the write, and released after it', () => {
            signedIn();
            const actualLock =
                jest.requireActual<typeof import('../../../src/ts/lockWait')>('../../../src/ts/lockWait');
            const events: string[] = [];
            loadFresh(() => {
                jest.doMock('../../../src/ts/lockWait', () => ({
                    acquireWithin: (acquire: () => { ok: boolean; release: () => void }, ms: number) => {
                        const lock = actualLock.acquireWithin(acquire, ms);
                        if (typeof lock === 'string') return lock;
                        events.push('locked');
                        return {
                            ...lock,
                            release: () => {
                                events.push('released');
                                lock.release();
                            },
                        };
                    },
                }));
            });
            const real = fs.renameSync;
            jest.spyOn(fs, 'renameSync').mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
                if (to === legacyFile) events.push('written');
                (real as (a: fs.PathLike, b: fs.PathLike) => void)(from, to);
            }) as typeof fs.renameSync);

            settings.loadSettings();
            events.length = 0;

            settings.setSetting('theme', 'light');

            expect(events).toEqual(['locked', 'written', 'released']);
            expect(fs.readdirSync(userData).filter((name) => name.endsWith('.lock'))).toEqual([]);
        });
    });
});
