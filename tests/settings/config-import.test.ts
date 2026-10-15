/**
 * The one-time import of a 1.x `settings.json` into `config.json`, against a real temp directory: when it runs (and
 * when it must not), what it writes (the configuration owner-only, the title pins, the marker) and what it leaves
 * (`settings.json` with only its sign-in state blanked), how it fails (nothing written, saves refused, a recovery
 * code), and the explicit ways out (retry, start fresh, import again).
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

// What a 1.x file holds: a few settings, the sign-in state, a rule naming a profile that is not there, a challenge with
// an override, a suppression and a pin, a renamed key, and a title pin.
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
// What a start leaves in the file once the import has run: the sign-in state blanked, nothing else touched.
const BLANKED = { ...ONE_X, token: '', apiHeaders: {}, lastUsername: '', chosenPhotosMemberId: '' };

describe('the one-time import of a 1.x settings.json (real fs)', () => {
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
        test('writes config.json owner-only, the pins and the marker, and leaves settings.json with only its sign-in state blanked', () => {
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
                sha256: '',
                report: { refsBlocked: ['rules[0].profile: "Gone"'] },
                acknowledged: false,
            });

            // On disk: the same configuration, written owner-only, and the title pins and the marker beside it.
            expect(stored(configFile)).toMatchObject({ version: 2, imported: { acknowledged: false } });
            if (process.platform !== 'win32') expect(fs.statSync(configFile).mode & 0o777).toBe(0o600);
            expect(stored(pinsFile)).toEqual({ '101': 'Macro World' });
            expect(stored(markerFile)).toEqual({ importedAt: expect.any(String) });

            // settings.json: the four sign-in fields blanked, everything else as it was parsed.
            expect(stored(legacyFile)).toEqual({
                ...ONE_X,
                token: '',
                apiHeaders: {},
                lastUsername: '',
                chosenPhotosMemberId: '',
            });
            expect(fs.readFileSync(legacyFile, 'utf8')).toBe(
                JSON.stringify(
                    { ...ONE_X, token: '', apiHeaders: {}, lastUsername: '', chosenPhotosMemberId: '' },
                    null,
                    2,
                ),
            );
        });

        test('imports once: the next loads (and the next process) read config.json, not settings.json', () => {
            fs.writeFileSync(legacyFile, RAW);
            loadFresh();
            settings.loadSettings();
            const importedAt = settings.loadSettings().imported?.at;
            // A 1.x change made after the import (a downgrade, a CLI sharing the directory) is not imported again.
            fs.writeFileSync(legacyFile, JSON.stringify({ ...ONE_X, theme: 'light', token: '' }));

            loadFresh();

            expect(settings.loadSettings().app.theme).toBe('dark');
            expect(settings.loadSettings().imported?.at).toBe(importedAt);
        });

        test('carries the mock mode only when the file held one; the build default applies otherwise', () => {
            fs.writeFileSync(legacyFile, JSON.stringify({ ...ONE_X, mock: undefined }));
            loadFresh();
            settings.loadSettings();
            expect(Object.hasOwn(stored(configFile).app as object, 'mock')).toBe(false);
            expect(settings.loadSettings().app.mock).toBe(settings.getDefaultSettings().app.mock);
        });

        test('a file that holds no sign-in state is not rewritten', () => {
            const clean = `${JSON.stringify({ theme: 'dark', token: '', apiHeaders: {} })}`;
            fs.writeFileSync(legacyFile, clean);
            const before = fs.statSync(legacyFile).mtimeMs;
            loadFresh();

            settings.loadSettings();

            expect(fs.readFileSync(legacyFile, 'utf8')).toBe(clean);
            expect(fs.statSync(legacyFile).mtimeMs).toBe(before);
        });
    });

    describe('when it must not run', () => {
        test('with a configuration already there: settings.json is not even read', () => {
            fs.writeFileSync(configFile, JSON.stringify({ app: { theme: 'light' } }));
            fs.writeFileSync(legacyFile, RAW);
            loadFresh();

            expect(settings.loadSettings().app.theme).toBe('light');

            expect(fs.existsSync(markerFile)).toBe(false);
            expect(fs.existsSync(pinsFile)).toBe(false);
        });

        test('with the marker there and no configuration: defaults, and settings.json stays as it is', () => {
            fs.writeFileSync(markerFile, '{"importedAt":"2026-01-01T00:00:00.000Z"}');
            fs.writeFileSync(legacyFile, RAW);
            loadFresh();

            expect(settings.loadSettings()).toEqual(settings.getDefaultSettings());
            expect(settings.getSettingsRecovery()).toBeNull();

            expect(fs.existsSync(configFile)).toBe(false);
            expect(stored(legacyFile)).toEqual(BLANKED);
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
            expect(stored(legacyFile)).toEqual(BLANKED);
        });

        test('an empty settings.json is no 1.x file either', () => {
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
            expect(settings.saveAppSettings({ theme: 'dark' })).toBe(false);
            expect(settings.setSetting('token', 'planted')).toBe(false);
        });

        test.each([
            ['an Error', () => Object.assign(new Error('EACCES: denied'), { code: 'EACCES' }), 'EACCES'],
            ['a value that carries no message', () => 'weird', 'unknown error'],
        ])('a settings.json that cannot be read (%s): unreadable, nothing written', (_name, thrown, said) => {
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
            expect(cat.error).toHaveBeenCalledWith(expect.stringContaining('(unreadable)'));
            expect(cat.error).toHaveBeenCalledWith(expect.stringContaining(said));
            jest.restoreAllMocks();
            expectNothingWritten();
        });

        test('a file the 1.x pipeline cannot handle: migration-failed, nothing written', () => {
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

        test('a configuration that cannot be written: write-failed, and the legacy sign-in state is not blanked', () => {
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
                code: 'settings-import-failed',
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
                        markImportDone: jest.fn(),
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

            expect(acquired).toEqual([{ id: 'config-import', options: { category: 'settings', internal: true } }]);
            expect(released).toBe(1);
            expect(fs.readdirSync(userData).filter((name) => name.endsWith('.lock'))).toEqual([]);
            // A load that finds the configuration takes no lock.
            settings.loadSettings();
            expect(acquired).toHaveLength(1);
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

            expect(fs.readFileSync(legacyFile, 'utf8')).toBe(RAW);
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
            expect(stored(legacyFile)).toEqual(BLANKED);
        });
    });

    describe('a configuration another process saved while this one converted', () => {
        const convertingWhile = (write: () => void) =>
            loadFresh(() => {
                jest.doMock('../../src/ts/settings/importV1', () => ({
                    importV1Settings: () => {
                        write();
                        return { ok: true, config: { version: 2 }, titlePins: {}, report: { refsBlocked: [] } };
                    },
                }));
            });

        test('is adopted, and nothing of this import is marked or blanked', () => {
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

    describe('the sign-in state a 1.x login leaves in settings.json', () => {
        const IMPORTED_AND_PLANTED = () => {
            fs.writeFileSync(legacyFile, RAW);
            loadFresh();
            settings.loadSettings();
        };

        test('is blanked again at the next start while the marker exists, and nothing else is touched', () => {
            IMPORTED_AND_PLANTED();
            // A 1.x login after a downgrade, and a setting changed there meanwhile.
            fs.writeFileSync(
                legacyFile,
                JSON.stringify({ ...ONE_X, theme: 'light', token: 'planted', apiHeaders: { x: 'y' } }, null, 2),
            );

            loadFresh();
            settings.loadSettings();

            expect(stored(legacyFile)).toEqual({
                ...ONE_X,
                theme: 'light',
                token: '',
                apiHeaders: {},
                lastUsername: '',
                chosenPhotosMemberId: '',
            });
            expect(cat.info).toHaveBeenCalledWith('Cleared the sign-in state left in settings.json');
        });

        test('is looked at once per process, not on every read', () => {
            IMPORTED_AND_PLANTED();
            loadFresh();
            settings.loadSettings();
            fs.writeFileSync(legacyFile, JSON.stringify({ token: 'planted-later' }));

            settings.loadSettings();

            expect(stored(legacyFile)).toEqual({ token: 'planted-later' });
        });

        test.each([
            ['is not JSON', '{broken'],
            ['holds a root that is not an object', '[1]'],
            ['is gone', null],
        ])('a settings.json that %s is left as it is', (_name, text) => {
            IMPORTED_AND_PLANTED();
            if (text === null) fs.rmSync(legacyFile);
            else fs.writeFileSync(legacyFile, text);

            loadFresh();
            expect(() => settings.loadSettings()).not.toThrow();

            if (text === null) expect(fs.existsSync(legacyFile)).toBe(false);
            else expect(fs.readFileSync(legacyFile, 'utf8')).toBe(text);
        });

        test('a blanking that fails is logged and does not fail the load', () => {
            IMPORTED_AND_PLANTED();
            fs.writeFileSync(legacyFile, JSON.stringify({ token: 'planted' }));
            loadFresh();
            const realOpen = fs.openSync;
            jest.spyOn(fs, 'openSync').mockImplementation(((file: fs.PathLike, ...rest: unknown[]) => {
                if (String(file).includes('settings.json')) throw new Error('EROFS');
                return (realOpen as (...args: unknown[]) => unknown)(file, ...rest);
            }) as typeof fs.openSync);

            expect(settings.loadSettings().app.theme).toBe('dark');

            expect(cat.error).toHaveBeenCalledWith(
                'Could not clear the sign-in state left in settings.json:',
                expect.any(Error),
            );
        });

        test('a blanking that fails right after the import is logged too, and the import stands', () => {
            fs.writeFileSync(legacyFile, RAW);
            loadFresh();
            const realOpen = fs.openSync;
            jest.spyOn(fs, 'openSync').mockImplementation(((file: fs.PathLike, ...rest: unknown[]) => {
                if (String(file).includes('settings.json')) throw new Error('EROFS');
                return (realOpen as (...args: unknown[]) => unknown)(file, ...rest);
            }) as typeof fs.openSync);

            expect(settings.loadSettings().app.theme).toBe('dark');

            jest.restoreAllMocks();
            expect(fs.existsSync(configFile)).toBe(true);
            expect(fs.existsSync(markerFile)).toBe(true);
            expect(stored(legacyFile).token).toBe('tok-secret');
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
                expect.stringContaining('The 1.x settings could not be imported (corrupt)'),
            );
        });

        test('startFresh writes a default configuration and the marker, and leaves settings.json as the backup', () => {
            fs.writeFileSync(legacyFile, '{broken');
            loadFresh();
            settings.loadSettings();

            expect(settings.startFresh()).toBe(true);

            expect(settings.getSettingsRecovery()).toBeNull();
            expect(stored(configFile)).toMatchObject({ version: 2 });
            expect(stored(configFile)).not.toHaveProperty('imported');
            expect(fs.existsSync(markerFile)).toBe(true);
            expect(fs.readFileSync(legacyFile, 'utf8')).toBe('{broken');
            expect(settings.saveAppSettings({ theme: 'light' })).toBe(true);
            // A later start does not import the backup.
            loadFresh();
            expect(settings.loadSettings().app.theme).toBe('light');
        });

        test('startFresh leaves a configuration that is already there as it is', () => {
            fs.writeFileSync(configFile, JSON.stringify({ app: { theme: 'light' } }));
            loadFresh();

            expect(settings.startFresh()).toBe(true);

            expect(settings.loadSettings().app.theme).toBe('light');
            expect(fs.existsSync(markerFile)).toBe(false);
        });

        test('startFresh that cannot write says so and changes nothing', () => {
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
            expect(settings.getSettingsRecovery()?.code).toBe('settings-import-failed');
        });

        test('reimportFromV1 sets the configuration in use aside the way a damaged one is, then imports settings.json', () => {
            fs.writeFileSync(legacyFile, RAW);
            loadFresh();
            settings.loadSettings();
            expect(settings.saveAppSettings({ theme: 'light' })).toBe(true);
            const before = fs.readFileSync(configFile, 'utf8');
            // The 1.x file as a downgrade left it: another theme, a planted token.
            fs.writeFileSync(legacyFile, JSON.stringify({ ...ONE_X, theme: 'dracula', token: 'planted' }, null, 2));

            expect(settings.reimportFromV1()).toBe(true);

            expect(settings.loadSettings().app.theme).toBe('dracula');
            // The user stays signed in: the re-import keeps the sign-in state of the configuration it replaces, and
            // nothing a downgrade planted in settings.json comes with it.
            expect(settings.loadSettings().auth).toEqual({
                token: 'tok-secret',
                apiHeaders: { 'x-a': 'b' },
                lastUsername: 'me@example.com',
                chosenPhotosMemberId: 'm-1',
            });
            const [backup] = backups();
            expect(backups()).toHaveLength(1);
            expect(fs.readFileSync(path.join(userData, backup), 'utf8')).toBe(before);
            expect(stored(legacyFile).token).toBe('');
            expect(settings.getSettingsRecovery()).toBeNull();
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

        test('reimportFromV1 that fails after the configuration was set aside blocks saves until retried, and the retry imports again keeping the sign-in state', () => {
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
                code: 'settings-import-failed',
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

        test('retryImport with no settings.json says it did not work', () => {
            loadFresh();

            expect(settings.retryImport()).toBe(false);

            expect(settings.getSettingsRecovery()?.code).toBe('settings-import-failed');
            expect(fs.existsSync(configFile)).toBe(false);
        });

        test.each([
            ['is not JSON', '{broken', 'planted'],
            ['is not an object', '[1]', 'planted'],
            ['has no sign-in state', '{"app":{}}', 'planted'],
            ['holds an unusable token', '{"auth":{"token":5}}', 'planted'],
            ['holds a usable one', '{"auth":{"token":"mine"}}', 'mine'],
        ])(
            'reimportFromV1 over a configuration that %s keeps what it can of the sign-in state',
            (_name, current, token) => {
                fs.writeFileSync(legacyFile, JSON.stringify({ ...ONE_X, token: 'planted' }));
                fs.writeFileSync(configFile, current);
                loadFresh();

                expect(settings.reimportFromV1()).toBe(true);

                expect(settings.loadSettings().auth.token).toBe(token);
            },
        );

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

        test('a title pin the cache holds gives way to the one the 1.x file held; the others stay', () => {
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
