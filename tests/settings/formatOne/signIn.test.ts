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
            cat = invalid<typeof loggerModule & { __cat: CatDouble }>(
                require('../../../src/ts/logger') as typeof loggerModule,
            ).__cat;
        });
    };
    const stored = (file: string) => parseJsonObject(fs.readFileSync(file, 'utf8'));
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
        jest.restoreAllMocks();
        jest.dontMock('../../../src/ts/runtime');
        jest.dontMock('../../../src/ts/lockWait');
        jest.dontMock('../../../src/ts/settings/importV1');
        fs.rmSync(root, { recursive: true, force: true });
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

        test('a copy that cannot be read is logged without its text, and the others are still cleared', () => {
            signedIn();
            arrangeCopies();
            const real = fs.readFileSync;
            jest.spyOn(fs, 'readFileSync').mockImplementation(((file: fs.PathLike | number, ...rest: unknown[]) => {
                if (String(file).endsWith('config.json.corrupt-2026-10-16T08-00-00-000Z')) throw new Error('EIO');
                return (real as (...args: unknown[]) => unknown)(file, ...rest);
            }) as typeof fs.readFileSync);

            expect(settings.setSetting('token', '')).toBe(true);

            expect(cat.error).toHaveBeenCalledWith(
                'config.json.corrupt-2026-10-16T08-00-00-000Z could not be rewritten:',
                expect.any(Error),
            );
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
                expect(state).toEqual({ code: 'settings-corrupt', path: path.join(userData, backup), blocking: false });
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

        test('a restore that could not run (the import lock was busy) with no settings.json leaves nothing to set aside, and says none was', () => {
            damaged();
            fs.rmSync(legacyFile);
            loadFresh(() => {
                jest.doMock('../../../src/ts/lockWait', () => ({ acquireWithin: () => 'busy' }));
            });
            settings.loadSettings();
            expect(settings.getSettingsRecovery()?.code).toBe('settings-corrupt');

            // (The mirror finds the lock busy too, and tries again with the next save.)
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

            expect(settings.reimportFromV1Detailed()).toEqual({ ok: false, setAside: null });

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
            expect(result).toEqual({ ok: true, setAside: path.join(userData, copy) });
            expect(settings.loadSettings().auth).toMatchObject({ token: 'tok-9', lastUsername: 'other@example.com' });
            // What was in use went to the copy, sign-in included, until the next logout clears it.
            expect(stored(path.join(userData, copy)).auth).toMatchObject({ token: 'tok-1' });
            expect(settings.reimportFromV1()).toBe(true);
        });

        test('says nothing was set aside when there was no configuration in use, and that it failed when there is no settings.json', () => {
            signedIn();
            fs.rmSync(configFile);

            expect(settings.reimportFromV1Detailed()).toEqual({ ok: true, setAside: null });

            fs.rmSync(legacyFile);
            fs.rmSync(configFile);
            expect(settings.reimportFromV1Detailed()).toEqual({ ok: false, setAside: null });
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
