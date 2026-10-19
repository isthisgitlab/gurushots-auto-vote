/**
 * The import of a `settings.json` into `config.json`, against a real temp directory: when it runs (and when it must
 * not), what it writes (the configuration owner-only, the title pins, the marker) and what the mirror leaves in
 * `settings.json` (the sign-in state kept, the file as the user had it kept as `settings.json.original`), how it fails
 * (nothing written, saves refused, a recovery code), and the explicit ways out (retry, start fresh, import again).
 */

// A partial mock of the real fs (a builtin's exports are not spy-able as is), so a failure can be injected while every
// other call stays real.
jest.mock('node:fs', () => {
    const actual = jest.requireActual<typeof import('node:fs')>('node:fs');
    return { __esModule: true, ...actual, default: actual };
});
jest.unmock('path');
jest.unmock('node:path');
jest.mock('../../src/ts/logger', () => {
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
import type * as runtimeModule from '../../src/ts/runtime';
import type * as settingsModule from '../../src/ts/settings';
import type * as storageModule from '../../src/ts/settings/storage';
import type * as loggerModule from '../../src/ts/logger';
import type * as joinStateModule from '../../src/ts/joinStateStore';
import type { CategoryLogger } from '../../src/ts/logger';
import { invalid } from '../helpers/invalid';
import { parseJsonObject } from '../helpers/parseJson';

type CatDouble = jest.Mocked<Pick<CategoryLogger, 'info' | 'error' | 'debug' | 'success' | 'warning'>>;

// What a settings.json holds: a few settings, the sign-in state, a rule naming a profile that is not there, a challenge
// with an override, a suppression and a pin, a renamed key, and a title pin.
const ONE_X = {
    theme: 'dark',
    language: 'lv',
    mock: true,
    token: 'tok-secret',
    apiHeaders: { 'x-a': 'b' },
    lastUsername: 'me@example.com',
    chosenPhotosMemberId: 'm-1',
    autovoteRunning: true,
    challengeSettings: {
        globalDefaults: { autoFill: true, exposure: 80, autovoteRunning: true },
        perChallenge: { '101': { emergencyFill: 600 } },
        titleRules: [{ title: 'Macro', profile: 'Gone', autoFill: true }],
        titleProfileSuppressions: { '101': true },
        entryPins: { '101': { boost: 'e1' } },
        titlePins: { '101': 'Macro World' },
    },
};
const RAW = `${JSON.stringify(ONE_X, null, 2)}\n`;

describe('the import of a settings.json (real fs)', () => {
    let root: string;
    let userData: string;
    let configFile: string;
    let legacyFile: string;
    let markerFile: string;
    let pinsFile: string;
    let originalFile: string;
    let settings: typeof settingsModule;
    let storage: typeof storageModule;
    let cat: CatDouble;

    // Each test gets its own module graph: the recovery state lives in the settings module.
    const loadFresh = (setup?: () => void) => {
        jest.isolateModules(() => {
            // A factory, not a spy: `jest.restoreAllMocks()` in a test must not send the module back to the real user-data folder.
            const actualRuntime = jest.requireActual<typeof runtimeModule>('../../src/ts/runtime');
            jest.doMock('../../src/ts/runtime', () => ({
                __esModule: true,
                ...actualRuntime,
                getAppUserDataPath: () => userData,
            }));
            setup?.();
            settings = require('../../src/ts/settings') as typeof settingsModule;
            storage = require('../../src/ts/settings/storage') as typeof storageModule;
            cat = invalid<typeof loggerModule & { __cat: CatDouble }>(
                require('../../src/ts/logger') as typeof loggerModule,
            ).__cat;
        });
    };
    const backups = () => fs.readdirSync(userData).filter((name) => name.startsWith('config.json.corrupt-'));
    const stored = (file: string) => parseJsonObject(fs.readFileSync(file, 'utf8'));

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'gs-import-'));
        userData = path.join(root, 'userData');
        fs.mkdirSync(userData);
        configFile = path.join(userData, 'config.json');
        legacyFile = path.join(userData, 'settings.json');
        markerFile = path.join(userData, 'v2-import.json');
        pinsFile = path.join(userData, 'titlePins.json');
        originalFile = path.join(userData, 'settings.json.original');
    });

    afterEach(() => {
        jest.restoreAllMocks();
        jest.dontMock('../../src/ts/runtime');
        jest.dontMock('../../src/ts/lockWait');
        jest.dontMock('../../src/ts/settings/importV1');
        jest.dontMock('../../src/ts/joinStateStore');
        jest.dontMock('../../src/ts/settings/importMarker');
        fs.rmSync(root, { recursive: true, force: true });
    });

    describe('what the first load without a configuration does', () => {
        test("writes config.json owner-only, the pins and the marker; settings.json becomes the mirror, the user's file is kept", () => {
            fs.writeFileSync(legacyFile, RAW);
            loadFresh();

            const loaded = settings.loadSettings();

            expect(settings.getSettingsRecovery()).toBeNull();
            expect(loaded.app).toMatchObject({ theme: 'dark', language: 'lv', mock: true, autovoteRunning: true });
            expect(loaded.auth).toEqual({
                token: 'tok-secret',
                apiHeaders: { 'x-a': 'b' },
                lastUsername: 'me@example.com',
                chosenPhotosMemberId: 'm-1',
            });
            expect(loaded.defaults).toMatchObject({ autoSubmit: true, exposure: 80 });
            expect(loaded.defaults).not.toHaveProperty('autovoteRunning');
            expect(loaded.rules).toEqual([{ title: 'Macro', profile: 'Gone', autoSubmit: true }]);
            expect(loaded.challenges).toEqual({
                '101': { values: { emergencySubmit: 600 }, suppressRuleProfile: true, pins: { boost: 'e1' } },
            });
            expect(loaded.imported).toEqual({
                at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
                report: {
                    refsBlocked: [
                        { holder: { kind: 'rule', number: 1, title: 'Macro' }, refers: 'profile', name: 'Gone' },
                    ],
                },
                acknowledged: false,
            });

            // On disk: the same configuration, written owner-only, and the title pins and the marker beside it.
            expect(stored(configFile)).toMatchObject({ version: 2, imported: { acknowledged: false } });
            if (process.platform !== 'win32') expect(fs.statSync(configFile).mode & 0o777).toBe(0o600);
            expect(stored(pinsFile)).toEqual({ '101': 'Macro World' });
            // The marker keeps a copy of the import record, so a restored configuration has its report back.
            expect(stored(markerFile)).toEqual({
                configFrom: 'import',
                importedAt: expect.any(String),
                importedRecord: stored(configFile).imported,
                mirrorStartedAt: expect.any(String),
                signInConfirmed: expect.any(String),
            });

            // settings.json is the mirror: the sign-in state is still in it, under the format-1 names.
            expect(stored(legacyFile)).toMatchObject({
                theme: 'dark',
                token: 'tok-secret',
                apiHeaders: { 'x-a': 'b' },
                lastUsername: 'me@example.com',
                chosenPhotosMemberId: 'm-1',
                challengeSettings: {
                    globalDefaults: { autoFill: true, exposure: 80 },
                    perChallenge: { '101': { emergencyFill: 600 } },
                    titleRules: [{ title: 'Macro', profile: 'Gone', autoFill: true }],
                    titleProfileSuppressions: { '101': true },
                    entryPins: { '101': { boost: 'e1' } },
                    titlePins: { '101': 'Macro World' },
                },
            });
            // The file the user had is kept as it was, owner-only.
            expect(fs.readFileSync(originalFile, 'utf8')).toBe(RAW);
            if (process.platform !== 'win32') expect(fs.statSync(originalFile).mode & 0o777).toBe(0o600);
        });

        test.each([
            ['an empty timezone is Riga, as it was in format 1', '', 'Europe/Riga'],
            ['a blank timezone is kept, as format 1 took it for an invalid zone', '  ', '  '],
            ['a zone is kept', 'Asia/Tokyo', 'Asia/Tokyo'],
        ])('%s', (_name, written, imported) => {
            fs.writeFileSync(legacyFile, JSON.stringify({ ...ONE_X, timezone: written }));
            loadFresh();

            expect(settings.loadSettings().app.timezone).toBe(imported);
        });

        test('imports once: the next loads (and the next process) read config.json, not settings.json', () => {
            fs.writeFileSync(legacyFile, RAW);
            loadFresh();
            settings.loadSettings();
            const importedAt = settings.loadSettings().imported?.at;
            // A setting an older build changed after the import is not imported again: it is written over by the mirror.
            fs.writeFileSync(legacyFile, JSON.stringify({ ...ONE_X, theme: 'light' }));

            loadFresh();

            expect(settings.loadSettings().app.theme).toBe('dark');
            expect(settings.loadSettings().imported?.at).toBe(importedAt);
            expect(stored(legacyFile)).toMatchObject({ theme: 'dark', token: 'tok-secret' });
        });

        test('carries the mock mode only when the file held one; the build default applies otherwise', () => {
            fs.writeFileSync(legacyFile, JSON.stringify({ ...ONE_X, mock: undefined }));
            loadFresh();
            settings.loadSettings();
            expect(Object.hasOwn(stored(configFile).app as object, 'mock')).toBe(false);
            expect(settings.loadSettings().app.mock).toBe(settings.getDefaultSettings().app.mock);
        });
    });

    describe('a marker made only to record a sign-out', () => {
        test('does not stand for the import: a never-imported install still imports settings.json', () => {
            fs.writeFileSync(legacyFile, RAW);
            fs.writeFileSync(markerFile, JSON.stringify({ signOutScrubPending: 'a-sign-out' }));
            loadFresh();

            settings.loadSettings();

            expect(stored(configFile)).toMatchObject({ version: 2 });
            // The import is marked, and the record was worked off at the start (there were no copies to clear).
            expect(stored(markerFile)).toMatchObject({ importedAt: expect.any(String) });
            expect(stored(markerFile)).not.toHaveProperty('signOutScrubPending');
        });

        test('an unreadable marker is still the mark it was: settings.json is not imported unasked', () => {
            fs.writeFileSync(legacyFile, RAW);
            fs.writeFileSync(markerFile, '{garbage');
            loadFresh();

            settings.loadSettings();

            expect(fs.existsSync(configFile)).toBe(false);
        });
    });

    describe('when it must not run', () => {
        test('with a configuration already there: settings.json is not imported, and becomes its mirror', () => {
            fs.writeFileSync(configFile, JSON.stringify({ app: { theme: 'light' } }));
            fs.writeFileSync(legacyFile, RAW);
            loadFresh();

            expect(settings.loadSettings().app.theme).toBe('light');

            expect(fs.existsSync(markerFile)).toBe(false);
            expect(fs.existsSync(pinsFile)).toBe(false);
            expect(stored(legacyFile)).toMatchObject({ theme: 'light', token: '' });
            expect(fs.readFileSync(originalFile, 'utf8')).toBe(RAW);
        });

        test('with the marker there and no configuration, before the mirror has written: defaults, and settings.json stays as it is', () => {
            fs.writeFileSync(markerFile, '{"importedAt":"2026-01-01T00:00:00.000Z"}');
            fs.writeFileSync(legacyFile, RAW);
            loadFresh();

            expect(settings.loadSettings()).toEqual(settings.getDefaultSettings());
            expect(settings.getSettingsRecovery()).toBeNull();

            expect(fs.existsSync(configFile)).toBe(false);
            expect(fs.readFileSync(legacyFile, 'utf8')).toBe(RAW);
        });

        test('with the marker there, the mirror started and no configuration: restored from settings.json, without a report', () => {
            fs.writeFileSync(
                markerFile,
                '{"importedAt":"2026-01-01T00:00:00.000Z","mirrorStartedAt":"2026-01-01T00:00:01.000Z"}',
            );
            fs.writeFileSync(legacyFile, RAW);
            loadFresh();

            const loaded = settings.loadSettings();

            expect(loaded.app.theme).toBe('dark');
            expect(loaded.auth.token).toBe('tok-secret');
            expect(loaded.imported).toBeUndefined();
            expect(settings.getSettingsRecovery()).toBeNull();
            expect(stored(configFile)).not.toHaveProperty('imported');
            expect(cat.warning).toHaveBeenCalledWith(expect.stringContaining('restored from settings.json'));
        });

        test('with the mirror started and neither a configuration nor a settings.json: defaults, nothing to restore from', () => {
            fs.writeFileSync(
                markerFile,
                '{"importedAt":"2026-01-01T00:00:00.000Z","mirrorStartedAt":"2026-01-01T00:00:01.000Z"}',
            );
            loadFresh();

            expect(settings.loadSettings()).toEqual(settings.getDefaultSettings());

            expect(fs.existsSync(configFile)).toBe(false);
            expect(settings.getSettingsRecovery()).toBeNull();
        });

        test('with the mirror started and a settings.json that cannot be imported: the import failed notice, nothing written', () => {
            fs.writeFileSync(
                markerFile,
                '{"importedAt":"2026-01-01T00:00:00.000Z","mirrorStartedAt":"2026-01-01T00:00:01.000Z"}',
            );
            fs.writeFileSync(legacyFile, '{broken');
            loadFresh();

            settings.loadSettings();

            expect(settings.getSettingsRecovery()).toEqual({
                code: 'settings-import-failed',
                path: legacyFile,
                blocking: true,
            });
            expect(fs.existsSync(configFile)).toBe(false);
            expect(fs.readFileSync(legacyFile, 'utf8')).toBe('{broken');
        });

        test('with a set-aside configuration (config.json.corrupt-*) and no configuration', () => {
            fs.writeFileSync(path.join(userData, 'config.json.corrupt-2026-01-01T00-00-00-000Z'), '{broken');
            fs.writeFileSync(legacyFile, RAW);
            loadFresh();

            expect(settings.loadSettings()).toEqual(settings.getDefaultSettings());

            expect(fs.existsSync(configFile)).toBe(false);
            expect(fs.existsSync(markerFile)).toBe(false);
            expect(fs.readFileSync(legacyFile, 'utf8')).toBe(RAW);
        });

        test('a user-data directory that cannot be listed counts as holding no set-aside copy', () => {
            fs.writeFileSync(legacyFile, RAW);
            loadFresh();
            const realReaddir = fs.readdirSync;
            jest.spyOn(fs, 'readdirSync').mockImplementation(((dir: fs.PathLike, ...rest: unknown[]) => {
                if (String(dir) === userData) throw new Error('EIO');
                return (realReaddir as (...args: unknown[]) => unknown)(dir, ...rest);
            }) as typeof fs.readdirSync);

            expect(settings.loadSettings().app.theme).toBe('dark');
        });

        test('with no settings.json (a fresh install): no configuration, the marker, and a settings.json that shows up later is not imported', () => {
            loadFresh();

            expect(settings.loadSettings()).toEqual(settings.getDefaultSettings());

            expect(fs.existsSync(configFile)).toBe(false);
            expect(fs.existsSync(markerFile)).toBe(true);
            fs.writeFileSync(legacyFile, RAW);
            loadFresh();
            expect(settings.loadSettings()).toEqual(settings.getDefaultSettings());
            expect(fs.existsSync(configFile)).toBe(false);
            expect(fs.readFileSync(legacyFile, 'utf8')).toBe(RAW);
        });

        test('an empty settings.json is no file to import either', () => {
            fs.writeFileSync(legacyFile, '');
            loadFresh();

            expect(settings.loadSettings()).toEqual(settings.getDefaultSettings());
            expect(fs.existsSync(markerFile)).toBe(true);
            expect(fs.existsSync(configFile)).toBe(false);
        });
    });

    describe('when it fails', () => {
        const expectNothingWritten = () => {
            expect(fs.existsSync(configFile)).toBe(false);
            expect(fs.existsSync(markerFile)).toBe(false);
            expect(fs.existsSync(pinsFile)).toBe(false);
            expect(backups()).toEqual([]);
        };

        test.each([
            ['a settings.json that is not JSON', '{"theme":"dark"', 'corrupt'],
            ['a settings.json whose root is not an object', '[1,2]', 'corrupt'],
        ])('%s writes nothing, refuses saves and says so', (_name, text, reason) => {
            fs.writeFileSync(legacyFile, text);
            loadFresh();

            expect(settings.loadSettings()).toEqual(settings.getDefaultSettings());

            expect(settings.getSettingsRecovery()).toEqual({
                code: 'settings-import-failed',
                path: legacyFile,
                blocking: true,
            });
            expectNothingWritten();
            expect(fs.readFileSync(legacyFile, 'utf8')).toBe(text);
            expect(cat.error).toHaveBeenCalledWith(expect.stringContaining(`(${reason})`));
            // The parser's message can quote the text, the token among it: the log says only that it is not JSON.
            expect(JSON.stringify(cat.error.mock.calls)).not.toContain('Unexpected');
            expect(settings.saveAppSettings({ theme: 'dark' })).toBe(false);
            expect(settings.setSetting('token', 'planted')).toBe(false);
        });

        test.each([
            [
                'an Error with a code that will not pass',
                () => Object.assign(new Error('EACCES: denied'), { code: 'EACCES' }),
                'EACCES',
                'inaccessible',
                'settings-import-failed',
            ],
            [
                'an Error that may pass (busy)',
                () => Object.assign(new Error('EBUSY: busy'), { code: 'EBUSY' }),
                'EBUSY',
                'unreadable',
                'settings-import-retrying',
            ],
            [
                'a value that carries no message',
                () => 'weird',
                'unknown error',
                'unreadable',
                'settings-import-retrying',
            ],
        ])('a settings.json that cannot be read (%s): %s, nothing written', (_name, thrown, said, reason, code) => {
            fs.writeFileSync(legacyFile, RAW);
            loadFresh();
            const realRead = fs.readFileSync;
            jest.spyOn(fs, 'readFileSync').mockImplementation(
                invalid<typeof fs.readFileSync>((file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
                    if (file === legacyFile) throw thrown();
                    return (realRead as (...args: unknown[]) => unknown)(file, ...rest);
                }),
            );

            expect(settings.loadSettings()).toEqual(settings.getDefaultSettings());

            expect(settings.getSettingsRecovery()).toEqual({ code, path: legacyFile, blocking: true });
            expect(cat.error).toHaveBeenCalledWith(expect.stringContaining(`(${reason})`));
            expect(cat.error).toHaveBeenCalledWith(expect.stringContaining(said));
            jest.restoreAllMocks();
            expectNothingWritten();
        });

        test.each([
            ...['EBUSY', 'EAGAIN', 'EINTR', 'EMFILE', 'ENFILE', 'ETIMEDOUT', 'EIO'].map(
                (code) => [code, 'unreadable', 'settings-import-retrying'] as const,
            ),
            ...['EACCES', 'EPERM', 'EISDIR', 'ENOTDIR', 'ELOOP'].map(
                (code) => [code, 'inaccessible', 'settings-import-failed'] as const,
            ),
        ])('a read of settings.json that fails with %s is %s: %s', (errno, reason, code) => {
            fs.writeFileSync(legacyFile, RAW);
            loadFresh();
            const realRead = fs.readFileSync;
            jest.spyOn(fs, 'readFileSync').mockImplementation(
                invalid<typeof fs.readFileSync>((file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
                    if (file === legacyFile) throw Object.assign(new Error(`${errno}: failed`), { code: errno });
                    return (realRead as (...args: unknown[]) => unknown)(file, ...rest);
                }),
            );

            settings.loadSettings();

            expect(settings.getSettingsRecovery()?.code).toBe(code);
            expect(cat.error).toHaveBeenCalledWith(expect.stringContaining(`(${reason})`));
        });

        test('a file the frozen pipeline cannot handle: migration-failed, nothing written', () => {
            fs.writeFileSync(legacyFile, RAW);
            loadFresh(() => {
                jest.doMock('../../src/ts/settings/importV1', () => ({
                    importV1Settings: () => ({ ok: false, code: 'migration-failed', detail: 'a pass exploded' }),
                }));
            });

            settings.loadSettings();

            expect(settings.getSettingsRecovery()).toEqual({
                code: 'settings-import-failed',
                path: legacyFile,
                blocking: true,
            });
            expect(cat.error).toHaveBeenCalledWith(expect.stringContaining('(migration-failed): a pass exploded'));
            expectNothingWritten();
            expect(fs.readFileSync(legacyFile, 'utf8')).toBe(RAW);
        });

        test('a configuration that cannot be written: write-failed, and settings.json is not touched', () => {
            fs.writeFileSync(legacyFile, RAW);
            loadFresh();
            const realOpen = fs.openSync;
            jest.spyOn(fs, 'openSync').mockImplementation(((file: fs.PathLike, ...rest: unknown[]) => {
                if (String(file).includes('config.json')) throw new Error('EROFS: read-only file system');
                return (realOpen as (...args: unknown[]) => unknown)(file, ...rest);
            }) as typeof fs.openSync);

            settings.loadSettings();

            expect(settings.getSettingsRecovery()).toEqual({
                code: 'settings-import-retrying',
                path: legacyFile,
                blocking: true,
            });
            expect(cat.error).toHaveBeenCalledWith(expect.stringContaining('EROFS'));
            expect(fs.readFileSync(legacyFile, 'utf8')).toBe(RAW);
            expect(fs.existsSync(markerFile)).toBe(false);
        });

        test('title pins that cannot be written: write-failed before the configuration is touched', () => {
            fs.writeFileSync(legacyFile, RAW);
            loadFresh();
            const realWrite = fs.writeFileSync;
            jest.spyOn(fs, 'writeFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
                if (String(file).includes('titlePins')) throw new Error('ENOSPC');
                return (realWrite as (...args: unknown[]) => unknown)(file, ...rest);
            }) as typeof fs.writeFileSync);
            const realOpen = fs.openSync;
            jest.spyOn(fs, 'openSync').mockImplementation(((file: fs.PathLike, ...rest: unknown[]) => {
                if (String(file).includes('titlePins')) throw new Error('ENOSPC');
                return (realOpen as (...args: unknown[]) => unknown)(file, ...rest);
            }) as typeof fs.openSync);

            settings.loadSettings();

            expect(settings.getSettingsRecovery()?.code).toBe('settings-import-retrying');
            expect(cat.error).toHaveBeenCalledWith(expect.stringContaining('the title pins could not be saved'));
            jest.restoreAllMocks();
            expect(fs.existsSync(configFile)).toBe(false);
            expect(fs.existsSync(markerFile)).toBe(false);
        });

        test('is not tried again on every read: the damaged file is read and converted once', () => {
            fs.writeFileSync(legacyFile, '{broken');
            loadFresh();
            const read = jest.spyOn(fs, 'readFileSync');

            settings.loadSettings();
            const reads = read.mock.calls.filter(([file]) => file === legacyFile).length;
            settings.loadSettings();
            settings.getEffectiveSetting('exposure', '7');

            expect(read.mock.calls.filter(([file]) => file === legacyFile).length).toBe(reads);
            expect(cat.error).toHaveBeenCalledTimes(1);
        });

        test('another process holding the import lock: busy, nothing written, said in the log', () => {
            fs.writeFileSync(legacyFile, RAW);
            loadFresh(() => {
                jest.doMock('../../src/ts/lockWait', () => ({ acquireWithin: () => 'busy' }));
            });

            settings.loadSettings();

            expect(settings.getSettingsRecovery()).toEqual({
                code: 'settings-import-retrying',
                path: legacyFile,
                blocking: true,
            });
            expect(cat.error).toHaveBeenCalledWith(expect.stringContaining('another process is importing'));
            expectNothingWritten();
        });

        test('an import lock that cannot be taken at all fails closed too', () => {
            fs.writeFileSync(legacyFile, RAW);
            loadFresh(() => {
                jest.doMock('../../src/ts/lockWait', () => ({ acquireWithin: () => 'unavailable' }));
            });

            settings.loadSettings();

            expect(cat.error).toHaveBeenCalledWith(expect.stringContaining('the import lock cannot be taken'));
            expectNothingWritten();
        });

        test.each([
            ['an Error', () => new Error('marker store exploded'), 'marker store exploded'],
            ['a value that carries no message', () => 'weird', 'unknown error'],
        ])(
            'an unexpected throw (%s) while it runs is a failure, not a crash, and the lock is released',
            (_name, thrown, said) => {
                fs.writeFileSync(legacyFile, RAW);
                const release = jest.fn();
                loadFresh(() => {
                    jest.doMock('../../src/ts/lockWait', () => ({ acquireWithin: () => ({ ok: true, release }) }));
                    jest.doMock('../../src/ts/settings/importMarker', () => ({
                        isImportMarked: () => {
                            throw thrown();
                        },
                        isMirrorStarted: () => false,
                        markImportDone: jest.fn(),
                        markMirrorStarted: jest.fn(),
                        importMarkerStore: { initializeAsync: jest.fn() },
                    }));
                });

                expect(() => settings.loadSettings()).not.toThrow();

                expect(cat.error).toHaveBeenCalledWith(expect.stringContaining(said));
                expect(release).toHaveBeenCalledTimes(1);
            },
        );
    });

    describe('the lock', () => {
        test('the import runs under the import lock, which is released, and the lock file is not left behind', () => {
            fs.writeFileSync(legacyFile, RAW);
            const acquired: Array<{ id: unknown; options: unknown }> = [];
            let released = 0;
            loadFresh(() => {
                const actual = jest.requireActual<typeof joinStateModule>('../../src/ts/joinStateStore');
                jest.doMock('../../src/ts/joinStateStore', () => ({
                    ...actual,
                    acquireUnlockLock: (id: string, options: unknown) => {
                        acquired.push({ id, options });
                        const lock = actual.acquireUnlockLock(id, invalid(options));
                        return {
                            ...lock,
                            release: () => {
                                released += 1;
                                lock.release();
                            },
                        };
                    },
                }));
            });

            settings.loadSettings();

            // The import, then the mirror of the imported configuration.
            const lock = { id: 'config-import', options: { category: 'settings', internal: true } };
            expect(acquired).toEqual([lock, lock]);
            expect(released).toBe(2);
            expect(fs.readdirSync(userData).filter((name) => name.endsWith('.lock'))).toEqual([]);
            // A load that finds the configuration takes no lock.
            settings.loadSettings();
            expect(acquired).toHaveLength(2);
        });

        test.each([
            ['a fresh install (no settings.json)', () => undefined],
            [
                'a marker with no configuration',
                () => fs.writeFileSync(markerFile, '{"importedAt":"2026-01-01T00:00:00.000Z"}'),
            ],
            [
                'a set-aside configuration',
                () => fs.writeFileSync(path.join(userData, 'config.json.corrupt-2026-01-01T00-00-00-000Z'), '{'),
            ],
        ])('%s takes the lock once, not on every read', (_name, arrange) => {
            arrange();
            let taken = 0;
            loadFresh(() => {
                const actual = jest.requireActual<typeof joinStateModule>('../../src/ts/joinStateStore');
                jest.doMock('../../src/ts/joinStateStore', () => ({
                    ...actual,
                    acquireUnlockLock: (id: string, options: unknown) => {
                        taken += 1;
                        return actual.acquireUnlockLock(id, invalid(options));
                    },
                }));
            });

            settings.loadSettings();
            settings.getSetting('theme');
            settings.loadSettings();

            expect(taken).toBe(1);
        });

        test('a configuration another process saved while this one waited is adopted, not imported over', () => {
            fs.writeFileSync(legacyFile, RAW);
            loadFresh(() => {
                jest.doMock('../../src/ts/lockWait', () => ({
                    // The other process finishes its import while this one waits for the lock.
                    acquireWithin: () => {
                        fs.writeFileSync(configFile, JSON.stringify({ app: { theme: 'light' } }));
                        return { ok: true, release: () => undefined };
                    },
                }));
            });

            expect(settings.loadSettings().app.theme).toBe('light');

            expect(fs.readFileSync(originalFile, 'utf8')).toBe(RAW);
            expect(fs.existsSync(markerFile)).toBe(false);
        });

        test('the marker another process wrote while this one waited stands the import down', () => {
            fs.writeFileSync(legacyFile, RAW);
            loadFresh(() => {
                jest.doMock('../../src/ts/lockWait', () => ({
                    acquireWithin: () => {
                        fs.writeFileSync(markerFile, '{"importedAt":"2026-01-01T00:00:00.000Z"}');
                        return { ok: true, release: () => undefined };
                    },
                }));
            });

            expect(settings.loadSettings()).toEqual(settings.getDefaultSettings());

            expect(fs.existsSync(configFile)).toBe(false);
            expect(fs.readFileSync(legacyFile, 'utf8')).toBe(RAW);
        });
    });

    describe('a configuration another process saved while this one converted', () => {
        const convertingWhile = (write: () => void) =>
            loadFresh(() => {
                jest.doMock('../../src/ts/settings/importV1', () => ({
                    importV1Settings: () => {
                        write();
                        return {
                            ok: true,
                            config: { version: 2, app: {} },
                            titlePins: {},
                            report: { refsBlocked: [] },
                        };
                    },
                }));
            });

        test('is adopted, and nothing of this import is marked', () => {
            fs.writeFileSync(legacyFile, RAW);
            convertingWhile(() => fs.writeFileSync(configFile, JSON.stringify({ app: { theme: 'light' } })));

            expect(settings.loadSettings().app.theme).toBe('light');

            expect(settings.getSettingsRecovery()).toBeNull();
            expect(fs.existsSync(markerFile)).toBe(false);
            expect(fs.readFileSync(originalFile, 'utf8')).toBe(RAW);
        });

        test('that is empty cannot be adopted: the import fails and says so', () => {
            fs.writeFileSync(legacyFile, RAW);
            convertingWhile(() => fs.writeFileSync(configFile, ''));

            settings.loadSettings();

            expect(settings.getSettingsRecovery()).toEqual({
                code: 'settings-import-retrying',
                path: legacyFile,
                blocking: true,
            });
            expect(cat.error).toHaveBeenCalledWith(expect.stringContaining('config.json could not be read'));
            expect(fs.existsSync(markerFile)).toBe(false);
        });
    });

    describe('the explicit ways out', () => {
        test('retryImport imports once the file is fixed', () => {
            fs.writeFileSync(legacyFile, '{broken');
            loadFresh();
            settings.loadSettings();
            expect(settings.getSettingsRecovery()?.code).toBe('settings-import-failed');

            fs.writeFileSync(legacyFile, RAW);
            expect(settings.retryImport()).toBe(true);

            expect(settings.getSettingsRecovery()).toBeNull();
            expect(settings.loadSettings().app.theme).toBe('dark');
            expect(fs.existsSync(configFile)).toBe(true);
            expect(settings.saveAppSettings({ theme: 'light' })).toBe(true);
        });

        test('retryImport on a file that is still broken fails again, and is said again', () => {
            fs.writeFileSync(legacyFile, '{broken');
            loadFresh();
            settings.loadSettings();

            expect(settings.retryImport()).toBe(false);

            expect(settings.getSettingsRecovery()?.code).toBe('settings-import-failed');
            expect(cat.error).toHaveBeenCalledWith(
                expect.stringContaining('settings.json could not be imported (corrupt)'),
            );
        });

        test('startFresh writes a default configuration and the marker; the unimportable file is set aside before the mirror writes over it', () => {
            fs.writeFileSync(legacyFile, '{broken');
            loadFresh();
            settings.loadSettings();

            expect(settings.startFresh()).toBe(true);

            expect(settings.getSettingsRecovery()).toBeNull();
            expect(stored(configFile)).toMatchObject({ version: 2 });
            expect(stored(configFile)).not.toHaveProperty('imported');
            expect(fs.existsSync(markerFile)).toBe(true);
            expect(settings.saveAppSettings({ theme: 'light' })).toBe(true);
            expect(fs.readFileSync(originalFile, 'utf8')).toBe('{broken');
            expect(stored(legacyFile)).toMatchObject({ theme: 'light' });
            // A later start does not import the copy.
            loadFresh();
            expect(settings.loadSettings().app.theme).toBe('light');
        });

        test('startFresh that cannot set settings.json aside writes nothing and says so; once it can, it does', () => {
            fs.writeFileSync(legacyFile, '{broken');
            loadFresh();
            settings.loadSettings();
            const realOpen = fs.openSync;
            jest.spyOn(fs, 'openSync').mockImplementation(((file: fs.PathLike, ...rest: unknown[]) => {
                if (String(file).includes('settings.json.')) throw new Error('ENOSPC');
                return (realOpen as (...args: unknown[]) => unknown)(file, ...rest);
            }) as typeof fs.openSync);

            expect(settings.startFresh()).toBe(false);

            expect(fs.existsSync(configFile)).toBe(false);
            expect(fs.readFileSync(legacyFile, 'utf8')).toBe('{broken');
            expect(cat.error).toHaveBeenCalledWith(expect.stringContaining('could not be set aside'));
            expect(settings.getSettingsRecovery()?.code).toBe('settings-import-retrying');
            jest.restoreAllMocks();
            expect(settings.startFresh()).toBe(true);
            expect(fs.readFileSync(originalFile, 'utf8')).toBe('{broken');
        });

        test('startFresh with nothing to set aside (no settings.json) just starts', () => {
            loadFresh();

            expect(settings.startFresh()).toBe(true);

            expect(fs.readdirSync(userData).filter((name) => name.startsWith('settings.json'))).toEqual([]);
            expect(fs.existsSync(configFile)).toBe(true);
        });

        test('startFresh keeps a copy of its own when the original cannot be written but another file can', () => {
            fs.writeFileSync(legacyFile, '{broken');
            loadFresh();
            settings.loadSettings();
            const realOpen = fs.openSync;
            jest.spyOn(fs, 'openSync').mockImplementation(((file: fs.PathLike, ...rest: unknown[]) => {
                if (String(file).includes('settings.json.original')) throw new Error('EROFS');
                return (realOpen as (...args: unknown[]) => unknown)(file, ...rest);
            }) as typeof fs.openSync);

            expect(settings.startFresh()).toBe(true);

            jest.restoreAllMocks();
            const copies = fs.readdirSync(userData).filter((name) => name.startsWith('settings.json.unimportable-'));
            expect(copies).toHaveLength(1);
            expect(fs.readFileSync(path.join(userData, copies[0]), 'utf8')).toBe('{broken');
            expect(fs.existsSync(originalFile)).toBe(false);
        });

        test('the mirror does not write over the file the user had while the copy of it cannot be kept; it does once it can', () => {
            fs.writeFileSync(legacyFile, RAW);
            fs.writeFileSync(configFile, JSON.stringify({ app: { theme: 'light' } }));
            loadFresh();
            const realOpen = fs.openSync;
            jest.spyOn(fs, 'openSync').mockImplementation(((file: fs.PathLike, ...rest: unknown[]) => {
                if (String(file).includes('settings.json.original')) throw new Error('EROFS');
                return (realOpen as (...args: unknown[]) => unknown)(file, ...rest);
            }) as typeof fs.openSync);

            settings.loadSettings();

            expect(fs.readFileSync(legacyFile, 'utf8')).toBe(RAW);
            jest.restoreAllMocks();
            expect(settings.saveAppSettings({ theme: 'dark' })).toBe(true);
            // (A configuration that merely holds no login is no sign-out: the copy keeps the file as it was.)
            expect(fs.readFileSync(originalFile, 'utf8')).toBe(RAW);
            expect(stored(legacyFile)).toMatchObject({ theme: 'dark' });
        });

        test('startFresh sets settings.json aside as a copy of its own when settings.json.original is taken, whatever the mirror started', () => {
            fs.writeFileSync(legacyFile, RAW);
            loadFresh();
            settings.loadSettings();
            // The mirror has started and the user's first file is kept; an older build later wrote a file the import cannot read.
            fs.writeFileSync(legacyFile, '{broken');
            fs.rmSync(configFile);
            fs.writeFileSync(
                markerFile,
                '{"importedAt":"2026-01-01T00:00:00.000Z","mirrorStartedAt":"2026-01-01T00:00:01.000Z"}',
            );
            loadFresh();
            settings.loadSettings();
            expect(settings.getSettingsRecovery()?.code).toBe('settings-import-failed');

            expect(settings.startFresh()).toBe(true);
            expect(settings.saveAppSettings({ theme: 'light' })).toBe(true);

            const copies = fs.readdirSync(userData).filter((name) => name.startsWith('settings.json.unimportable-'));
            expect(copies).toHaveLength(1);
            expect(fs.readFileSync(path.join(userData, copies[0]), 'utf8')).toBe('{broken');
            if (process.platform !== 'win32') {
                expect(fs.statSync(path.join(userData, copies[0])).mode & 0o777).toBe(0o600);
            }
            // The first file the user had is still the one kept as the original (the default configuration holds no login,
            // so the copy holds none); the mirror has written over the other.
            expect(fs.readFileSync(originalFile, 'utf8')).toBe(RAW);
            expect(stored(legacyFile)).toMatchObject({ theme: 'light' });
        });

        test('startFresh leaves a configuration that is already there as it is', () => {
            fs.writeFileSync(configFile, JSON.stringify({ app: { theme: 'light' } }));
            loadFresh();

            expect(settings.startFresh()).toBe(true);

            expect(settings.loadSettings().app.theme).toBe('light');
            expect(fs.existsSync(markerFile)).toBe(false);
        });

        test('startFresh that cannot write the configuration says so and changes nothing', () => {
            fs.writeFileSync(legacyFile, '{broken');
            loadFresh();
            settings.loadSettings();
            const realOpen = fs.openSync;
            jest.spyOn(fs, 'openSync').mockImplementation(((file: fs.PathLike, ...rest: unknown[]) => {
                if (String(file).includes('config.json')) throw new Error('EROFS');
                return (realOpen as (...args: unknown[]) => unknown)(file, ...rest);
            }) as typeof fs.openSync);

            expect(settings.startFresh()).toBe(false);

            jest.restoreAllMocks();
            expect(fs.existsSync(configFile)).toBe(false);
            expect(settings.getSettingsRecovery()?.code).toBe('settings-import-retrying');
        });

        test('Start fresh over a settings.json that could not be read keeps its word once it can be read: it is set aside before any mirror write', () => {
            fs.writeFileSync(legacyFile, '{broken');
            loadFresh();
            settings.loadSettings();
            const unreadable = jest.spyOn(storage.legacyStorage, 'readRaw').mockImplementation(() => {
                throw Object.assign(new Error('EACCES: denied'), { code: 'EACCES' });
            });
            expect(settings.startFresh()).toBe(true);
            expect(stored(markerFile)).toMatchObject({ legacyAsideOwed: expect.any(String) });
            // Still unreadable: a save is not mirrored over it.
            expect(settings.setSetting('theme', 'light')).toBe(true);
            unreadable.mockRestore();
            expect(fs.readFileSync(legacyFile, 'utf8')).toBe('{broken');

            // Readable again: the next save sets it aside as a copy first, then mirrors.
            expect(settings.setSetting('theme', 'dark')).toBe(true);

            const copies = fs.readdirSync(userData).filter((name) => name.startsWith('settings.json.unimportable-'));
            expect(copies).toHaveLength(1);
            expect(fs.readFileSync(path.join(userData, copies[0]), 'utf8')).toBe('{broken');
            expect(stored(legacyFile)).toMatchObject({ theme: 'dark' });
            expect(stored(markerFile)).not.toHaveProperty('legacyAsideOwed');
        });

        test('the same in another process: the record in the marker has it set aside before that process mirrors over it', () => {
            fs.writeFileSync(legacyFile, '{broken');
            loadFresh();
            settings.loadSettings();
            const unreadable = jest.spyOn(storage.legacyStorage, 'readRaw').mockImplementation(() => {
                throw Object.assign(new Error('EACCES: denied'), { code: 'EACCES' });
            });
            expect(settings.startFresh()).toBe(true);
            unreadable.mockRestore();

            // The process ends; the next one finds the file readable and saves.
            loadFresh();
            settings.loadSettings();
            expect(settings.setSetting('theme', 'dark')).toBe(true);

            const copies = fs.readdirSync(userData).filter((name) => name.startsWith('settings.json.unimportable-'));
            expect(copies).toHaveLength(1);
            expect(fs.readFileSync(path.join(userData, copies[0]), 'utf8')).toBe('{broken');
            expect(stored(legacyFile)).toMatchObject({ theme: 'dark' });
        });

        test.each([
            ['an Error', () => new Error('EIO'), 'EIO'],
            ['a value that carries no message', () => 'weird', 'unknown error'],
        ])(
            'startFresh whose settings.json cannot be looked at (%s) keeps nothing, and writes the defaults',
            (_name, thrown, _said) => {
                fs.writeFileSync(legacyFile, '{broken');
                loadFresh();
                settings.loadSettings();
                jest.spyOn(storage.legacyStorage, 'readRaw').mockImplementation(() => {
                    throw thrown();
                });

                expect(settings.startFreshDetailed()).toEqual({ ok: true, keptAt: null, unreadable: true });

                // (Nothing to keep that can be read; the mirror never writes over a file it cannot read.)
                expect(fs.existsSync(configFile)).toBe(true);
                expect(fs.existsSync(originalFile)).toBe(false);
                expect(fs.readFileSync(legacyFile, 'utf8')).toBe('{broken');
            },
        );

        test('reimportFromV1 sets the configuration in use aside the way a damaged one is, then imports settings.json', () => {
            fs.writeFileSync(legacyFile, RAW);
            loadFresh();
            settings.loadSettings();
            expect(settings.saveAppSettings({ theme: 'light' })).toBe(true);
            const before = fs.readFileSync(configFile, 'utf8');
            // The file as an older build left it: another theme, another login.
            fs.writeFileSync(legacyFile, JSON.stringify({ ...ONE_X, theme: 'dracula', token: 'other' }, null, 2));

            expect(settings.reimportFromV1()).toBe(true);

            expect(settings.loadSettings().app.theme).toBe('dracula');
            // It imports the file as it is, sign-in state included: settings.json is where that state is kept.
            expect(settings.loadSettings().auth.token).toBe('other');
            const [backup] = backups();
            expect(backups()).toHaveLength(1);
            expect(fs.readFileSync(path.join(userData, backup), 'utf8')).toBe(before);
            expect(settings.getSettingsRecovery()).toBeNull();
            // And the mirror writes it back in its own form at the next load.
            settings.loadSettings();
            expect(stored(legacyFile)).toMatchObject({ theme: 'dracula', token: 'other' });
        });

        test('reimportFromV1 forgets the notice about a damaged configuration it replaces', () => {
            fs.writeFileSync(legacyFile, RAW);
            fs.writeFileSync(configFile, '{broken');
            loadFresh();
            settings.loadSettings();
            expect(settings.getSettingsRecovery()?.code).toBe('settings-corrupt');

            expect(settings.reimportFromV1()).toBe(true);

            expect(settings.getSettingsRecovery()).toBeNull();
            expect(settings.loadSettings().app.theme).toBe('dark');
        });

        test.each([
            ['is broken', '{broken'],
            ['is gone', null],
        ])('reimportFromV1 with a settings.json that %s changes nothing', (_name, text) => {
            fs.writeFileSync(legacyFile, RAW);
            loadFresh();
            settings.loadSettings();
            const config = fs.readFileSync(configFile, 'utf8');
            if (text === null) fs.rmSync(legacyFile);
            else fs.writeFileSync(legacyFile, text);

            expect(settings.reimportFromV1()).toBe(false);

            expect(fs.readFileSync(configFile, 'utf8')).toBe(config);
            expect(backups()).toEqual([]);
            expect(settings.getSettingsRecovery()).toBeNull();
            expect(settings.saveAppSettings({ theme: 'light' })).toBe(true);
        });

        test('reimportFromV1 that cannot set the configuration aside changes nothing', () => {
            fs.writeFileSync(legacyFile, RAW);
            loadFresh();
            settings.loadSettings();
            const config = fs.readFileSync(configFile, 'utf8');
            jest.spyOn(fs, 'renameSync').mockImplementation(() => {
                throw new Error('EPERM');
            });

            expect(settings.reimportFromV1()).toBe(false);

            expect(fs.readFileSync(configFile, 'utf8')).toBe(config);
            expect(cat.error).toHaveBeenCalledWith(expect.stringContaining('EPERM'));
        });

        test('reimportFromV1 that fails after the configuration was set aside blocks saves until retried, and the retry imports again', () => {
            fs.writeFileSync(legacyFile, RAW);
            loadFresh();
            settings.loadSettings();
            const realOpen = fs.openSync;
            jest.spyOn(fs, 'openSync').mockImplementation(((file: fs.PathLike, ...rest: unknown[]) => {
                if (String(file).includes('config.json')) throw new Error('EROFS');
                return (realOpen as (...args: unknown[]) => unknown)(file, ...rest);
            }) as typeof fs.openSync);

            expect(settings.reimportFromV1()).toBe(false);

            jest.restoreAllMocks();
            expect(fs.existsSync(configFile)).toBe(false);
            expect(backups()).toHaveLength(1);
            expect(settings.getSettingsRecovery()).toEqual({
                code: 'settings-import-retrying',
                path: legacyFile,
                blocking: true,
            });
            expect(settings.saveAppSettings({ theme: 'light' })).toBe(false);

            // The marker and the set-aside configuration make the automatic import skip; the retry is the explicit
            // import the failed operation was, and says it worked only because a configuration is stored now.
            expect(settings.retryImport()).toBe(true);

            expect(fs.existsSync(configFile)).toBe(true);
            expect(settings.getSettingsRecovery()).toBeNull();
            expect(settings.loadSettings().app.theme).toBe('dark');
            expect(settings.loadSettings().auth.token).toBe('tok-secret');
            expect(settings.saveAppSettings({ theme: 'light' })).toBe(true);
        });

        test('retryImport with a configuration stored already leaves it as it is', () => {
            fs.writeFileSync(configFile, JSON.stringify({ app: { theme: 'light' } }));
            loadFresh();

            expect(settings.retryImport()).toBe(true);

            expect(settings.loadSettings().app.theme).toBe('light');
        });

        test('retryImportDetailed says nothing was imported when a configuration is stored already, and plain success when it imported', () => {
            fs.writeFileSync(configFile, JSON.stringify({ app: { theme: 'light' } }));
            loadFresh();

            expect(settings.retryImportDetailed()).toEqual({ ok: true, adopted: true });
            expect(settings.loadSettings().app.theme).toBe('light');

            fs.rmSync(configFile);
            fs.writeFileSync(legacyFile, JSON.stringify(ONE_X));
            loadFresh();

            expect(settings.retryImportDetailed()).toEqual({ ok: true });
        });

        test('retryImport with no settings.json says it did not work', () => {
            loadFresh();

            expect(settings.retryImport()).toBe(false);

            expect(settings.getSettingsRecovery()?.code).toBe('settings-import-retrying');
            expect(fs.existsSync(configFile)).toBe(false);
        });

        test('reimportFromV1 over a configuration that holds a login imports the file as it is, and carries nothing over', () => {
            fs.writeFileSync(legacyFile, JSON.stringify({ ...ONE_X, token: 'from-file' }));
            fs.writeFileSync(configFile, JSON.stringify({ auth: { token: 'mine' } }));
            loadFresh();

            expect(settings.reimportFromV1()).toBe(true);

            expect(settings.loadSettings().auth.token).toBe('from-file');
        });

        test.each(['startFresh', 'reimportFromV1', 'retryImport'] as const)(
            '%s never throws, even when the stored configuration cannot be looked at',
            (action) => {
                fs.writeFileSync(legacyFile, RAW);
                loadFresh();
                jest.spyOn(fs, 'existsSync').mockImplementation(() => {
                    throw new Error('EIO');
                });

                expect(settings[action]()).toBe(false);

                expect(cat.error).toHaveBeenCalledWith(expect.stringContaining('EIO'));
            },
        );

        test('a recovery action that fails with a value that carries no message says so', () => {
            fs.writeFileSync(legacyFile, RAW);
            loadFresh();
            jest.spyOn(fs, 'existsSync').mockImplementation(() => {
                throw 'weird';
            });

            expect(settings.startFresh()).toBe(false);

            expect(cat.error).toHaveBeenCalledWith(expect.stringContaining('unknown error'));
        });

        test('a title pin the cache holds gives way to the one the file held; the others stay', () => {
            fs.writeFileSync(legacyFile, RAW);
            loadFresh();
            settings.loadSettings();
            settings.mergeTitlePins({ '202': 'Seen Later' }, ['101']);
            settings.mergeTitlePins({ '101': 'Cached Rename' }, []);
            expect(settings.getTitlePins()).toEqual({ '101': 'Cached Rename', '202': 'Seen Later' });
            fs.writeFileSync(legacyFile, RAW);

            expect(settings.reimportFromV1()).toBe(true);

            expect(settings.getTitlePins()).toEqual({ '101': 'Macro World', '202': 'Seen Later' });
        });
    });
});
