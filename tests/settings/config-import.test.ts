/**
 * The import of a `settings.json` into `config.json`, against a real temp directory: when it runs (once — the marker),
 * what it writes (the configuration owner-only, the title pins, the marker), how it fails (nothing settled and saves
 * refused while it may pass, the defaults stored and the file left as it is when it cannot), and the explicit ways out
 * (retry, start fresh).
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
    let settings: typeof settingsModule;
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
        test('writes config.json owner-only, the pins and the marker; settings.json is left as the user had it', () => {
            fs.writeFileSync(legacyFile, RAW);
            loadFresh();

            const loaded = settings.loadSettings();

            expect(settings.getSettingsRecovery()).toBeNull();
            expect(loaded.app).toMatchObject({ theme: 'dark', language: 'lv', mock: true, autovoteRunning: true });
            expect(loaded.auth).toEqual({
                token: 'tok-secret',
                apiHeaders: { 'x-a': 'b' },
                lastUsername: 'me@example.com',
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
            // The marker says the import is done, and nothing else.
            expect(stored(markerFile)).toEqual({ importedAt: expect.any(String) });

            // settings.json is not written to: it stays the file the user had.
            expect(fs.readFileSync(legacyFile, 'utf8')).toBe(RAW);
            expect(fs.readdirSync(userData).filter((name) => name.startsWith('settings.json'))).toEqual([
                'settings.json',
            ]);
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
            // A settings.json an older build wrote since is not read again: the configuration is the only source.
            fs.writeFileSync(legacyFile, JSON.stringify({ ...ONE_X, theme: 'light' }));

            loadFresh();

            expect(settings.loadSettings().app.theme).toBe('dark');
            expect(settings.loadSettings().imported?.at).toBe(importedAt);
            expect(fs.readFileSync(legacyFile, 'utf8')).toBe(JSON.stringify({ ...ONE_X, theme: 'light' }));
        });

        test('carries the mock mode only when the file held one; the build default applies otherwise', () => {
            fs.writeFileSync(legacyFile, JSON.stringify({ ...ONE_X, mock: undefined }));
            loadFresh();
            settings.loadSettings();
            expect(Object.hasOwn(stored(configFile).app as object, 'mock')).toBe(false);
            expect(settings.loadSettings().app.mock).toBe(settings.getDefaultSettings().app.mock);
        });
    });

    describe('the marker that says the import is done', () => {
        test.each([
            ['holds importedAt', '{"importedAt":"2026-01-01T00:00:00.000Z"}'],
            ['holds mirrorStartedAt', '{"mirrorStartedAt":"2026-01-01T00:00:01.000Z"}'],
            ['holds both', '{"importedAt":"2026-01-01T00:00:00.000Z","mirrorStartedAt":"2026-01-01T00:00:01.000Z"}'],
            ['is not a JSON object', '{garbage'],
        ])('%s: settings.json is not imported', (_name, marker) => {
            fs.writeFileSync(legacyFile, RAW);
            fs.writeFileSync(markerFile, marker);
            loadFresh();

            expect(settings.loadSettings()).toEqual(settings.getDefaultSettings());

            expect(fs.existsSync(configFile)).toBe(false);
            expect(settings.getSettingsRecovery()).toBeNull();
            expect(fs.readFileSync(legacyFile, 'utf8')).toBe(RAW);
        });

        test('a marker that cannot be read is still the mark it was: settings.json is not imported unasked', () => {
            fs.writeFileSync(legacyFile, RAW);
            fs.mkdirSync(markerFile);
            loadFresh();

            settings.loadSettings();

            expect(fs.existsSync(configFile)).toBe(false);
        });

        test('a marker holding only a field an older build wrote says nothing of the import: settings.json imports', () => {
            fs.writeFileSync(legacyFile, RAW);
            fs.writeFileSync(markerFile, JSON.stringify({ signOutScrubPending: 'a-sign-out' }));
            loadFresh();

            settings.loadSettings();

            expect(stored(configFile)).toMatchObject({ version: 2 });
            // The marker is written fresh: the import is the one fact it keeps.
            expect(stored(markerFile)).toEqual({ importedAt: expect.any(String) });
        });
    });

    describe('when it must not run', () => {
        test('with a configuration already there: settings.json is not imported and is left as it is', () => {
            fs.writeFileSync(configFile, JSON.stringify({ app: { theme: 'light' } }));
            fs.writeFileSync(legacyFile, RAW);
            loadFresh();

            expect(settings.loadSettings().app.theme).toBe('light');

            expect(fs.existsSync(markerFile)).toBe(false);
            expect(fs.existsSync(pinsFile)).toBe(false);
            expect(fs.readFileSync(legacyFile, 'utf8')).toBe(RAW);
        });

        test('with the marker there and no configuration: defaults, and settings.json stays as it is', () => {
            fs.writeFileSync(markerFile, '{"importedAt":"2026-01-01T00:00:00.000Z"}');
            fs.writeFileSync(legacyFile, RAW);
            loadFresh();

            expect(settings.loadSettings()).toEqual(settings.getDefaultSettings());
            expect(settings.getSettingsRecovery()).toBeNull();

            expect(fs.existsSync(configFile)).toBe(false);
            expect(fs.readFileSync(legacyFile, 'utf8')).toBe(RAW);
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
        test.each([
            ['a settings.json that is not JSON', '{"theme":"dark"'],
            ['a settings.json whose root is not an object', '[1,2]'],
        ])('%s settles as failed: the defaults are stored, the file is left as it is', (_name, text) => {
            fs.writeFileSync(legacyFile, text);
            loadFresh();

            expect(settings.loadSettings()).toEqual(settings.getDefaultSettings());

            // The failure is a notice, not a block: the defaults were stored, so saving works.
            expect(settings.getSettingsRecovery()).toEqual({
                code: 'settings-import-failed',
                path: legacyFile,
                blocking: false,
                detail: 'corrupt',
            });
            expect(stored(configFile)).toMatchObject({
                version: 2,
                imported: { acknowledged: true, failure: { reason: 'corrupt' } },
            });
            expect(stored(markerFile)).toEqual({ importedAt: expect.any(String) });
            expect(fs.readFileSync(legacyFile, 'utf8')).toBe(text);
            // The parser's message can quote the text, the token among it: the log says only that it is not JSON.
            expect(JSON.stringify(cat.error.mock.calls)).not.toContain('Unexpected');
            expect(cat.error).toHaveBeenCalledWith(expect.stringContaining('(corrupt)'));
            expect(settings.saveAppSettings({ theme: 'dark' })).toBe(true);
            expect(settings.setSetting('token', 'new-token')).toBe(true);
        });

        test('the next start after a failure that cannot pass is silent defaults, with no re-import', () => {
            fs.writeFileSync(legacyFile, '{broken');
            loadFresh();
            settings.loadSettings();
            expect(stored(configFile)).toMatchObject({ imported: { failure: { reason: 'corrupt' } } });

            loadFresh();

            expect(settings.loadSettings()).toEqual({
                ...settings.getDefaultSettings(),
                imported: {
                    at: expect.any(String),
                    report: { refsBlocked: [] },
                    acknowledged: true,
                    failure: { reason: 'corrupt', detail: 'it is not valid JSON' },
                },
            });
            expect(settings.getSettingsRecovery()).toBeNull();
            expect(fs.readFileSync(legacyFile, 'utf8')).toBe('{broken');
        });

        test('the steps the settled notice gives import the fixed file once: config.json and the marker go, settings.json is kept', () => {
            fs.writeFileSync(legacyFile, '{broken');
            loadFresh();
            settings.loadSettings();
            expect(stored(configFile)).toMatchObject({ imported: { failure: { reason: 'corrupt' } } });

            // The user fixed the file, then deleted config.json and v2-import.json beside it; settings.json stayed.
            fs.writeFileSync(legacyFile, RAW);
            fs.rmSync(configFile);
            fs.rmSync(markerFile);

            loadFresh();

            expect(settings.getSettingsRecovery()).toBeNull();
            expect(settings.loadSettings().app.theme).toBe('dark');
            expect(stored(markerFile)).toEqual({ importedAt: expect.any(String) });

            // That was the one import: the next start reads config.json, not settings.json.
            fs.writeFileSync(legacyFile, JSON.stringify({ ...ONE_X, theme: 'light' }));
            loadFresh();
            expect(settings.loadSettings().app.theme).toBe('dark');
        });

        test('a failed import is attempted once, however often the settings are read', () => {
            fs.writeFileSync(legacyFile, '{broken');
            let attempts = 0;
            loadFresh(() => {
                const actual = jest.requireActual<typeof import('../../src/ts/settings/importV1')>(
                    '../../src/ts/settings/importV1',
                );
                jest.doMock('../../src/ts/settings/importV1', () => ({
                    ...actual,
                    importV1Settings: (...args: unknown[]) => {
                        attempts += 1;
                        return (
                            actual.importV1Settings as (...a: unknown[]) => ReturnType<typeof actual.importV1Settings>
                        )(...args);
                    },
                }));
            });

            settings.loadSettings();
            settings.getSetting('theme');
            settings.loadSettings();
            settings.getEffectiveSetting('exposure', '7');

            expect(attempts).toBe(1);
            expect(settings.getSettingsRecovery()).toEqual({
                code: 'settings-import-failed',
                path: legacyFile,
                blocking: false,
                detail: 'corrupt',
            });
            // The defaults are in place: an explicit Retry finds them there and imports nothing.
            expect(settings.retryImportDetailed()).toEqual({ ok: true, adopted: true });
            expect(attempts).toBe(1);
        });

        test('a blocked import is attempted once over N reads, and Retry imports once the file can be read', () => {
            fs.writeFileSync(legacyFile, RAW);
            let reads = 0;
            loadFresh();
            const realRead = fs.readFileSync;
            const failing = jest.spyOn(fs, 'readFileSync').mockImplementation(
                invalid<typeof fs.readFileSync>((file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
                    if (file === legacyFile) {
                        reads += 1;
                        throw Object.assign(new Error('EBUSY: busy'), { code: 'EBUSY' });
                    }
                    return (realRead as (...args: unknown[]) => unknown)(file, ...rest);
                }),
            );

            // Many reads of the settings: the import is attempted once, never per read.
            settings.loadSettings();
            settings.getSetting('theme');
            settings.loadSettings();
            expect(reads).toBe(1);
            expect(settings.getSettingsRecovery()).toEqual({
                code: 'settings-import-failed',
                path: legacyFile,
                blocking: true,
            });

            // Readable again: Retry is the explicit import that stores it.
            failing.mockRestore();
            expect(settings.retryImport()).toBe(true);

            expect(settings.getSettingsRecovery()).toBeNull();
            expect(settings.loadSettings().app.theme).toBe('dark');
        });

        test.each([
            [
                'an Error with a code that will not pass',
                () => Object.assign(new Error('EACCES: denied'), { code: 'EACCES' }),
                'EACCES',
                'inaccessible',
            ],
            [
                'an Error that may pass (busy)',
                () => Object.assign(new Error('EBUSY: busy'), { code: 'EBUSY' }),
                'EBUSY',
                'unreadable',
            ],
            ['a value that carries no message', () => 'weird', 'unknown error', 'unreadable'],
        ])(
            'a settings.json that cannot be read (%s) blocks saves until it is tried again',
            (_name, thrown, said, reason) => {
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

                expect(settings.getSettingsRecovery()).toEqual({
                    code: 'settings-import-failed',
                    path: legacyFile,
                    blocking: true,
                });
                expect(cat.error).toHaveBeenCalledWith(expect.stringContaining(`(${reason})`));
                expect(cat.error).toHaveBeenCalledWith(expect.stringContaining(said));
                expect(settings.saveAppSettings({ theme: 'dark' })).toBe(false);
                expect(settings.setSetting('token', 'planted')).toBe(false);
                jest.restoreAllMocks();
                expect(fs.existsSync(configFile)).toBe(false);
                expect(fs.existsSync(markerFile)).toBe(false);
                expect(fs.existsSync(pinsFile)).toBe(false);
                expect(backups()).toEqual([]);
            },
        );

        test.each([
            ...['EBUSY', 'EAGAIN', 'EINTR', 'EMFILE', 'ENFILE', 'ETIMEDOUT', 'EIO'].map(
                (code) => [code, 'unreadable'] as const,
            ),
            ...['EACCES', 'EPERM', 'EISDIR', 'ENOTDIR', 'ELOOP'].map((code) => [code, 'inaccessible'] as const),
        ])('a read of settings.json that fails with %s blocks as %s', (errno, reason) => {
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

            expect(settings.getSettingsRecovery()).toEqual({
                code: 'settings-import-failed',
                path: legacyFile,
                blocking: true,
            });
            expect(cat.error).toHaveBeenCalledWith(expect.stringContaining(`(${reason})`));
        });

        test('a file the frozen pipeline cannot handle: the defaults are stored with the failure, and the file stays', () => {
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
                blocking: false,
                detail: 'migration-failed',
            });
            expect(cat.error).toHaveBeenCalledWith(expect.stringContaining('(migration-failed): a pass exploded'));
            expect(stored(configFile)).toMatchObject({
                imported: { acknowledged: true, failure: { reason: 'migration-failed', detail: 'a pass exploded' } },
            });
            expect(stored(markerFile)).toEqual({ importedAt: expect.any(String) });
            expect(fs.readFileSync(legacyFile, 'utf8')).toBe(RAW);
        });

        test('a configuration another process stores while the defaults are written is loaded, not overwritten', () => {
            fs.writeFileSync(legacyFile, '{broken');
            loadFresh();
            // The race the compare-and-write answers: config.json is missing at the load's read and at the import's,
            // and is there (another process saved its import) when the defaults are written. The third existence
            // check of the file in this run is the defaults write's.
            const realExists = fs.existsSync;
            let configChecks = 0;
            jest.spyOn(fs, 'existsSync').mockImplementation(
                invalid<typeof fs.existsSync>((target: fs.PathLike, ...rest: unknown[]) => {
                    if (target === configFile && ++configChecks === 3) {
                        fs.writeFileSync(configFile, JSON.stringify({ app: { theme: 'dark' }, version: 2 }, null, 2));
                        return true;
                    }
                    return (realExists as (...args: unknown[]) => boolean)(target, ...rest);
                }),
            );

            const loaded = settings.loadSettings();

            // The other process's configuration is the settings in use, and no settled failure stands.
            expect(settings.getSettingsRecovery()).toBeNull();
            expect(loaded.app).toMatchObject({ theme: 'dark' });
            expect(stored(configFile)).toEqual({ app: { theme: 'dark' }, version: 2 });
            expect(fs.existsSync(markerFile)).toBe(false);
        });

        test('an empty file planted in the same race cannot be adopted: the failure stays blocking', () => {
            fs.writeFileSync(legacyFile, '{broken');
            loadFresh();
            const realExists = fs.existsSync;
            let configChecks = 0;
            jest.spyOn(fs, 'existsSync').mockImplementation(
                invalid<typeof fs.existsSync>((target: fs.PathLike, ...rest: unknown[]) => {
                    if (target === configFile && ++configChecks === 3) {
                        fs.writeFileSync(configFile, '');
                        return true;
                    }
                    return (realExists as (...args: unknown[]) => boolean)(target, ...rest);
                }),
            );

            settings.loadSettings();

            expect(settings.getSettingsRecovery()).toEqual({
                code: 'settings-import-failed',
                path: legacyFile,
                blocking: true,
            });
            expect(cat.error).toHaveBeenCalledWith(expect.stringContaining('could not be saved'));
            expect(fs.existsSync(markerFile)).toBe(false);
        });

        test('a failed import whose defaults cannot be written either blocks until it is tried again', () => {
            fs.writeFileSync(legacyFile, '{broken');
            loadFresh();
            const realOpen = fs.openSync;
            jest.spyOn(fs, 'openSync').mockImplementation(((file: fs.PathLike, ...rest: unknown[]) => {
                if (String(file).includes('config.json')) throw new Error('EROFS: read-only file system');
                return (realOpen as (...args: unknown[]) => unknown)(file, ...rest);
            }) as typeof fs.openSync);

            expect(settings.loadSettings()).toEqual(settings.getDefaultSettings());

            expect(settings.getSettingsRecovery()).toEqual({
                code: 'settings-import-failed',
                path: legacyFile,
                blocking: true,
            });
            expect(fs.existsSync(configFile)).toBe(false);
            expect(fs.existsSync(markerFile)).toBe(false);
        });

        test('a configuration that cannot be written: blocked until it is tried again', () => {
            fs.writeFileSync(legacyFile, RAW);
            loadFresh();
            const realOpen = fs.openSync;
            jest.spyOn(fs, 'openSync').mockImplementation(((file: fs.PathLike, ...rest: unknown[]) => {
                if (String(file).includes('config.json')) throw new Error('EROFS: read-only file system');
                return (realOpen as (...args: unknown[]) => unknown)(file, ...rest);
            }) as typeof fs.openSync);

            settings.loadSettings();

            expect(settings.getSettingsRecovery()).toEqual({
                code: 'settings-import-failed',
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

            expect(settings.getSettingsRecovery()?.code).toBe('settings-import-failed');
            expect(cat.error).toHaveBeenCalledWith(expect.stringContaining('the title pins could not be saved'));
            jest.restoreAllMocks();
            expect(fs.existsSync(configFile)).toBe(false);
            expect(fs.existsSync(markerFile)).toBe(false);
        });

        test('another process holding the import lock: busy, nothing written, said in the log', () => {
            fs.writeFileSync(legacyFile, RAW);
            loadFresh(() => {
                jest.doMock('../../src/ts/lockWait', () => ({ acquireWithin: () => 'busy' }));
            });

            settings.loadSettings();

            expect(settings.getSettingsRecovery()).toEqual({
                code: 'settings-import-failed',
                path: legacyFile,
                blocking: true,
            });
            expect(cat.error).toHaveBeenCalledWith(expect.stringContaining('another process is importing'));
            expect(fs.existsSync(configFile)).toBe(false);
            expect(fs.existsSync(markerFile)).toBe(false);
            expect(backups()).toEqual([]);
        });

        test('an import lock that cannot be taken at all fails closed too', () => {
            fs.writeFileSync(legacyFile, RAW);
            loadFresh(() => {
                jest.doMock('../../src/ts/lockWait', () => ({ acquireWithin: () => 'unavailable' }));
            });

            settings.loadSettings();

            expect(cat.error).toHaveBeenCalledWith(expect.stringContaining('the import lock cannot be taken'));
            expect(fs.existsSync(configFile)).toBe(false);
            expect(fs.existsSync(markerFile)).toBe(false);
        });

        test.each([
            ['an Error', () => new Error('marker store exploded'), 'marker store exploded'],
            ['a value that carries no message', () => 'weird', 'unknown error'],
        ])(
            'an unexpected throw (%s) while the marker is looked at is a failure, not a crash',
            (_name, thrown, said) => {
                fs.writeFileSync(legacyFile, RAW);
                loadFresh(() => {
                    jest.doMock('../../src/ts/settings/importMarker', () => ({
                        isImportMarked: () => {
                            throw thrown();
                        },
                        markImportDone: jest.fn(),
                        flushPendingMarkerChanges: jest.fn(),
                        importMarkerStore: { initializeAsync: jest.fn() },
                    }));
                });

                expect(() => settings.loadSettings()).not.toThrow();

                expect(cat.error).toHaveBeenCalledWith(expect.stringContaining(said));
                expect(fs.existsSync(configFile)).toBe(false);
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

            const lock = { id: 'config-import', options: { category: 'settings', internal: true } };
            expect(acquired).toEqual([lock]);
            expect(released).toBe(1);
            expect(fs.readdirSync(userData).filter((name) => name.endsWith('.lock'))).toEqual([]);
            // A load that finds the configuration takes no lock.
            settings.loadSettings();
            expect(acquired).toHaveLength(1);
        });

        test.each([
            ['a fresh install (no settings.json)', () => undefined, 1],
            [
                'a marker with no configuration',
                () => fs.writeFileSync(markerFile, '{"importedAt":"2026-01-01T00:00:00.000Z"}'),
                0,
            ],
            [
                'a set-aside configuration',
                () => fs.writeFileSync(path.join(userData, 'config.json.corrupt-2026-01-01T00-00-00-000Z'), '{'),
                1,
            ],
        ])('%s takes the lock once, not on every read', (_name, arrange, takenOnce) => {
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

            expect(taken).toBe(takenOnce);
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

            expect(fs.existsSync(markerFile)).toBe(false);
            expect(fs.readFileSync(legacyFile, 'utf8')).toBe(RAW);
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
            expect(fs.readFileSync(legacyFile, 'utf8')).toBe(RAW);
        });

        test('that is empty cannot be adopted: the import fails and says so', () => {
            fs.writeFileSync(legacyFile, RAW);
            convertingWhile(() => fs.writeFileSync(configFile, ''));

            settings.loadSettings();

            expect(settings.getSettingsRecovery()).toEqual({
                code: 'settings-import-failed',
                path: legacyFile,
                blocking: true,
            });
            expect(cat.error).toHaveBeenCalledWith(expect.stringContaining('config.json could not be read'));
            expect(fs.existsSync(markerFile)).toBe(false);
        });
    });

    describe('the explicit ways out', () => {
        test('retryImport while the import lock is held fails again, and is said again', () => {
            fs.writeFileSync(legacyFile, RAW);
            loadFresh(() => {
                jest.doMock('../../src/ts/lockWait', () => ({ acquireWithin: () => 'busy' }));
            });
            settings.loadSettings();
            expect(settings.getSettingsRecovery()?.blocking).toBe(true);

            expect(settings.retryImport()).toBe(false);

            expect(settings.getSettingsRecovery()?.code).toBe('settings-import-failed');
            expect(cat.error).toHaveBeenCalledWith(
                expect.stringContaining('settings.json could not be imported (busy)'),
            );
            expect(fs.existsSync(configFile)).toBe(false);
        });

        test('startFresh writes a default configuration and the marker, and leaves settings.json as it is', () => {
            fs.writeFileSync(legacyFile, '{broken');
            loadFresh();
            const realRead = fs.readFileSync;
            const failing = jest.spyOn(fs, 'readFileSync').mockImplementation(
                invalid<typeof fs.readFileSync>((file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
                    if (file === legacyFile) throw Object.assign(new Error('EBUSY: busy'), { code: 'EBUSY' });
                    return (realRead as (...args: unknown[]) => unknown)(file, ...rest);
                }),
            );
            settings.loadSettings();
            expect(settings.getSettingsRecovery()?.blocking).toBe(true);

            // Nothing was written while the import was blocked; Start fresh gives it up.
            failing.mockRestore();
            expect(settings.startFresh()).toBe(true);

            expect(settings.getSettingsRecovery()).toBeNull();
            expect(stored(configFile)).toMatchObject({ version: 2 });
            expect(stored(configFile)).not.toHaveProperty('imported');
            expect(stored(markerFile)).toEqual({ importedAt: expect.any(String) });
            expect(settings.saveAppSettings({ theme: 'light' })).toBe(true);
            expect(fs.readFileSync(legacyFile, 'utf8')).toBe('{broken');
            // A later start does not import the file.
            loadFresh();
            expect(settings.loadSettings().app.theme).toBe('light');
        });

        test('startFresh with no settings.json just starts', () => {
            loadFresh();

            expect(settings.startFresh()).toBe(true);

            expect(fs.readdirSync(userData).filter((name) => name.startsWith('settings.json'))).toEqual([]);
            expect(fs.existsSync(configFile)).toBe(true);
        });

        test('startFresh adopting a configuration another writer saved while it wrote', () => {
            loadFresh();
            const realExists = fs.existsSync;
            let existsCalls = 0;
            jest.spyOn(fs, 'existsSync').mockImplementation(((file: fs.PathLike) => {
                if (String(file).includes('config.json')) {
                    existsCalls += 1;
                    // The read saw nothing; by the write, another process's configuration is there.
                    return existsCalls > 1 ? true : false;
                }
                return (realExists as (f: fs.PathLike) => boolean)(file);
            }) as typeof fs.existsSync);
            fs.writeFileSync(configFile, JSON.stringify({ app: { theme: 'light' } }));

            expect(settings.startFreshDetailed()).toEqual({ ok: true, adopted: true });

            expect(settings.loadSettings().app.theme).toBe('light');
            expect(fs.existsSync(markerFile)).toBe(false);
        });

        test('startFresh adopting a configuration another writer saved while it wrote', () => {
            loadFresh();
            const realExists = fs.existsSync;
            let existsCalls = 0;
            jest.spyOn(fs, 'existsSync').mockImplementation(((file: fs.PathLike) => {
                if (String(file).includes('config.json')) {
                    existsCalls += 1;
                    // The read saw nothing; by the write, another process's configuration is there.
                    return existsCalls > 1;
                }
                return (realExists as (f: fs.PathLike) => boolean)(file);
            }) as typeof fs.existsSync);
            fs.writeFileSync(configFile, JSON.stringify({ app: { theme: 'light' } }));

            expect(settings.startFreshDetailed()).toEqual({ ok: true, adopted: true });

            expect(settings.loadSettings().app.theme).toBe('light');
            expect(fs.existsSync(markerFile)).toBe(false);
        });

        test('startFresh racing an empty configuration file imports nothing and says so', () => {
            fs.writeFileSync(configFile, '');
            loadFresh();

            expect(settings.startFresh()).toBe(false);

            expect(cat.error).toHaveBeenCalledWith(expect.stringContaining('config.json could not be read'));
            expect(fs.existsSync(markerFile)).toBe(false);
        });

        test('startFresh leaves a configuration that is already there as it is', () => {
            fs.writeFileSync(configFile, JSON.stringify({ app: { theme: 'light' } }));
            loadFresh();

            expect(settings.startFresh()).toBe(true);

            expect(settings.loadSettings().app.theme).toBe('light');
            expect(fs.existsSync(markerFile)).toBe(false);
        });

        test('startFreshDetailed says nothing was reset when a configuration is there already', () => {
            fs.writeFileSync(configFile, JSON.stringify({ app: { theme: 'light' } }));
            fs.writeFileSync(legacyFile, RAW);
            loadFresh();

            expect(settings.startFreshDetailed()).toEqual({ ok: true, adopted: true });
            expect(settings.loadSettings().app.theme).toBe('light');
            expect(fs.readFileSync(legacyFile, 'utf8')).toBe(RAW);
        });

        test('startFresh that cannot write the configuration says so and changes nothing', () => {
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
            expect(settings.getSettingsRecovery()?.code).toBe('settings-import-failed');
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
            fs.rmSync(markerFile, { force: true });
            fs.writeFileSync(legacyFile, JSON.stringify(ONE_X));
            loadFresh();

            expect(settings.retryImportDetailed()).toEqual({ ok: true });
        });

        test('retryImport with no settings.json says it did not work', () => {
            loadFresh();

            expect(settings.retryImport()).toBe(false);

            expect(settings.getSettingsRecovery()?.code).toBe('settings-import-failed');
            expect(settings.getSettingsRecovery()?.blocking).toBe(true);
            expect(fs.existsSync(configFile)).toBe(false);
        });

        test.each(['startFresh', 'retryImport'] as const)(
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
            loadFresh();
            settings.loadSettings();
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
            // The import runs again only once the configuration and the marker are gone.
            fs.rmSync(configFile);
            fs.rmSync(markerFile);

            expect(settings.retryImport()).toBe(true);

            expect(settings.getTitlePins()).toEqual({ '101': 'Macro World', '202': 'Seen Later' });
        });
    });
});
