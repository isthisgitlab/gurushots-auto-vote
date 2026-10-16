/**
 * The mirror that keeps settings.json current in settings format 1, against a real temp directory: it follows every
 * save (sign-in state included, logout too), is not rewritten when nothing changed, keeps the user's file once as
 * settings.json.original, survives a write that fails (the configuration is intact and the mirror is made again), makes
 * itself again from the stored configuration when settings.json changed under it, and restores a missing or damaged
 * configuration from itself. Data an earlier build left (the configuration there, settings.json blanked and stale, a
 * marker with no mirror) gets its sign-in state back in settings.json and is not imported.
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
import type * as storageModule from '../../../src/ts/settings/storage';
import type * as loggerModule from '../../../src/ts/logger';
import type { CategoryLogger } from '../../../src/ts/logger';
import { invalid } from '../../helpers/invalid';
import { parseJsonObject } from '../../helpers/parseJson';

type CatDouble = jest.Mocked<Pick<CategoryLogger, 'info' | 'error' | 'debug' | 'success' | 'warning'>>;

// The file as the user's older build left it.
const USER_FILE = {
    theme: 'dark',
    token: 'tok-secret',
    apiHeaders: { 'x-a': 'b' },
    lastUsername: 'me@example.com',
    challengeSettings: { globalDefaults: { autoFill: true, exposure: 80 }, titlePins: { '101': 'Macro World' } },
};
const RAW = `${JSON.stringify(USER_FILE, null, 2)}\n`;

describe('the mirror of the configuration in settings.json (real fs)', () => {
    let root: string;
    let userData: string;
    let configFile: string;
    let legacyFile: string;
    let originalFile: string;
    let markerFile: string;
    let settings: typeof settingsModule;
    let storage: typeof storageModule;
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
            storage = require('../../../src/ts/settings/storage') as typeof storageModule;
            cat = invalid<typeof loggerModule & { __cat: CatDouble }>(
                require('../../../src/ts/logger') as typeof loggerModule,
            ).__cat;
        });
    };
    const stored = (file: string) => parseJsonObject(fs.readFileSync(file, 'utf8'));
    const writesTo = (file: string) => {
        const real = fs.renameSync;
        const spy = jest
            .spyOn(fs, 'renameSync')
            .mockImplementation(((from: fs.PathLike, to: fs.PathLike) =>
                (real as (a: fs.PathLike, b: fs.PathLike) => void)(from, to)) as typeof fs.renameSync);
        return () => spy.mock.calls.filter(([, to]) => to === file).length;
    };
    // Makes every write to settings.json fail while `failing` is set.
    const failingWrites = () => {
        const state = { failing: true };
        const realOpen = fs.openSync;
        jest.spyOn(fs, 'openSync').mockImplementation(((file: fs.PathLike, ...rest: unknown[]) => {
            if (state.failing && /settings\.json\.\d+\.[0-9a-f]+\.tmp$/.test(String(file))) throw new Error('EROFS');
            return (realOpen as (...args: unknown[]) => unknown)(file, ...rest);
        }) as typeof fs.openSync);
        return state;
    };

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'gs-mirror-'));
        userData = path.join(root, 'userData');
        fs.mkdirSync(userData);
        configFile = path.join(userData, 'config.json');
        legacyFile = path.join(userData, 'settings.json');
        originalFile = path.join(userData, 'settings.json.original');
        markerFile = path.join(userData, 'v2-import.json');
    });

    afterEach(() => {
        jest.restoreAllMocks();
        jest.dontMock('../../../src/ts/runtime');
        jest.dontMock('../../../src/ts/lockWait');
        fs.rmSync(root, { recursive: true, force: true });
    });

    describe('a mirror written by the other process between the two reads', () => {
        test('is not overwritten by a mirror of an older configuration: settings.json is read first, so the write is a conflict and is made again', () => {
            loadFresh();
            settings.setSetting('theme', 'dark');
            let interleaved = false;
            // Whichever of the two reads comes first, the CLI saves a newer configuration and mirrors it right after it.
            const interleave = () => {
                if (interleaved) return;
                interleaved = true;
                const config = stored(configFile);
                fs.writeFileSync(
                    configFile,
                    JSON.stringify({ ...config, app: { ...(config.app as object), language: 'lv' } }),
                );
                fs.writeFileSync(legacyFile, JSON.stringify({ ...stored(legacyFile), language: 'lv' }));
            };
            const readLegacy = storage.legacyStorage.readRaw.bind(storage.legacyStorage);
            const readConfig = storage.storage.peekRaw.bind(storage.storage);
            jest.spyOn(storage.legacyStorage, 'readRaw').mockImplementation(() => {
                const read = readLegacy();
                interleave();
                return read;
            });
            jest.spyOn(storage.storage, 'peekRaw').mockImplementation(() => {
                const read = readConfig();
                interleave();
                return read;
            });

            settings.setSetting('theme', 'light');

            // The newer configuration's language is still there, and so is this save's theme.
            expect(stored(legacyFile)).toMatchObject({ theme: 'light', language: 'lv' });
        });
    });

    describe('after every save', () => {
        test('settings.json holds the configuration in format 1, the sign-in state included', () => {
            loadFresh();

            expect(settings.setSetting('theme', 'dark')).toBe(true);
            expect(settings.setSetting('token', 'tok-1')).toBe(true);
            expect(settings.setGlobalDefault('autoSubmit', true)).toBe(true);

            expect(stored(legacyFile)).toMatchObject({
                theme: 'dark',
                token: 'tok-1',
                challengeSettings: { globalDefaults: { autoFill: true } },
            });
            if (process.platform !== 'win32') expect(fs.statSync(legacyFile).mode & 0o777).toBe(0o600);
        });

        test('a logout is mirrored: the token is gone from settings.json too', () => {
            loadFresh();
            settings.setSetting('token', 'tok-1');
            expect(stored(legacyFile).token).toBe('tok-1');

            settings.setSetting('token', '');

            expect(stored(legacyFile).token).toBe('');
        });

        test("a logout takes the token, the API headers and the user name out of the copy of the user's file too, and says nothing of it", () => {
            fs.writeFileSync(legacyFile, RAW);
            loadFresh();
            settings.loadSettings();
            // The import kept the login: the copy holds the file as it was.
            expect(fs.readFileSync(originalFile, 'utf8')).toBe(RAW);

            expect(settings.setSetting('token', '')).toBe(true);

            const kept = stored(originalFile);
            // The copy keeps no user name; the live mirror and the configuration do (the login form is prefilled from them).
            expect(kept).toMatchObject({ token: '', apiHeaders: {}, lastUsername: '', theme: 'dark' });
            expect(stored(legacyFile)).toMatchObject({ lastUsername: 'me@example.com' });
            expect(JSON.stringify(cat.info.mock.calls)).not.toContain('tok-secret');
            expect(JSON.stringify(cat.debug.mock.calls)).not.toContain('tok-secret');
            if (process.platform !== 'win32') expect(fs.statSync(originalFile).mode & 0o777).toBe(0o600);
            // A login made afterwards does not go into it.
            settings.setSetting('token', 'tok-2');
            expect(stored(originalFile).token).toBe('');
        });

        test('a copy that holds no login, or is not JSON, is left as it is when the configuration is signed out', () => {
            fs.writeFileSync(legacyFile, '{broken');
            loadFresh();
            settings.loadSettings();
            expect(settings.startFresh()).toBe(true);

            settings.setSetting('theme', 'dark');

            expect(fs.readFileSync(originalFile, 'utf8')).toBe('{broken');
            fs.writeFileSync(originalFile, JSON.stringify({ theme: 'dark', token: '' }));
            settings.setSetting('theme', 'light');
            expect(fs.readFileSync(originalFile, 'utf8')).toBe(JSON.stringify({ theme: 'dark', token: '' }));
            fs.writeFileSync(originalFile, '[1]');
            settings.setSetting('theme', 'dark');
            expect(fs.readFileSync(originalFile, 'utf8')).toBe('[1]');
        });

        test('nothing is rewritten when the mirror would be the same', () => {
            loadFresh();
            settings.setSetting('theme', 'dark');
            const renamedOver = writesTo(legacyFile);
            settings.setSetting('theme', 'light');
            expect(renamedOver()).toBe(1);

            settings.setSetting('theme', 'light');
            settings.saveAppSettings({ language: 'en' });

            expect(renamedOver()).toBe(1);
        });

        test('a change of the title pins is mirrored, and so is a reset (which clears them after the save)', () => {
            loadFresh();
            settings.setSetting('token', 'tok-1');

            expect(settings.mergeTitlePins({ '9': 'Night Sky' })).toBe(true);
            expect(stored(legacyFile).challengeSettings).toMatchObject({ titlePins: { '9': 'Night Sky' } });

            expect(settings.resetAllSettings()).toBe(true);

            expect(stored(legacyFile).challengeSettings).toMatchObject({ titlePins: {} });
            expect(stored(legacyFile).token).toBe('tok-1');
        });

        test('nothing is mirrored while the stored settings cannot be used', () => {
            fs.writeFileSync(legacyFile, '{broken');
            loadFresh();
            settings.loadSettings();
            expect(settings.getSettingsRecovery()?.code).toBe('settings-import-failed');

            expect(settings.mergeTitlePins({ '9': 'Night Sky' })).toBe(true);
            expect(settings.setSetting('theme', 'dark')).toBe(false);

            expect(fs.readFileSync(legacyFile, 'utf8')).toBe('{broken');
            expect(fs.existsSync(originalFile)).toBe(false);
        });
    });

    describe('the file the user had', () => {
        test('is kept once as settings.json.original, owner-only, before the first mirror writes over it', () => {
            fs.writeFileSync(legacyFile, RAW);
            loadFresh();

            settings.loadSettings();

            expect(fs.readFileSync(originalFile, 'utf8')).toBe(RAW);
            if (process.platform !== 'win32') expect(fs.statSync(originalFile).mode & 0o777).toBe(0o600);
            expect(stored(legacyFile)).not.toEqual(USER_FILE);
        });

        test('is never replaced afterwards, not by a later save, a later start, or a file an older build wrote', () => {
            fs.writeFileSync(legacyFile, RAW);
            loadFresh();
            settings.loadSettings();
            settings.setSetting('theme', 'light');
            fs.writeFileSync(legacyFile, JSON.stringify({ theme: 'dracula' }));

            loadFresh();
            settings.setSetting('theme', 'dark');

            expect(fs.readFileSync(originalFile, 'utf8')).toBe(RAW);
            expect(stored(legacyFile).theme).toBe('dark');
        });

        test('is not made of the mirror itself: a fresh install writes settings.json and never a copy of it', () => {
            loadFresh();

            settings.setSetting('theme', 'dark');
            settings.setSetting('theme', 'light');
            loadFresh();
            settings.setSetting('theme', 'dracula');

            expect(fs.existsSync(originalFile)).toBe(false);
            expect(stored(markerFile)).toHaveProperty('mirrorStartedAt');
        });
    });

    describe('a mirror that cannot be written', () => {
        test('leaves the configuration saved, says so without the text, and is made again by the next save', () => {
            loadFresh();
            settings.setSetting('token', 'tok-1');
            const writes = failingWrites();

            expect(settings.setSetting('theme', 'dark')).toBe(true);

            expect(stored(configFile).app).toMatchObject({ theme: 'dark' });
            expect(stored(legacyFile)).toMatchObject({ token: 'tok-1' });
            expect(stored(legacyFile)).not.toMatchObject({ theme: 'dark' });
            expect(cat.warning).toHaveBeenCalledWith(expect.stringContaining('could not be brought up to date'));
            expect(JSON.stringify(cat.warning.mock.calls)).not.toContain('tok-1');
            expect(JSON.stringify(cat.error.mock.calls)).not.toContain('tok-1');

            writes.failing = false;
            expect(settings.setSetting('language', 'lv')).toBe(true);

            expect(stored(legacyFile)).toMatchObject({ theme: 'dark', language: 'lv' });
        });

        test('is made again at the next start, from the configuration', () => {
            loadFresh();
            settings.setSetting('token', 'tok-1');
            const writes = failingWrites();
            settings.setSetting('theme', 'dark');
            writes.failing = false;

            loadFresh();
            settings.loadSettings();

            expect(stored(legacyFile)).toMatchObject({ token: 'tok-1', theme: 'dark' });
        });

        test('a logout whose mirror failed is retried: the token is not left only in settings.json', () => {
            loadFresh();
            settings.setSetting('token', 'tok-1');
            const writes = failingWrites();

            expect(settings.setSetting('token', '')).toBe(true);
            expect(stored(configFile).auth).toMatchObject({ token: '' });
            expect(stored(legacyFile).token).toBe('tok-1');

            writes.failing = false;
            settings.setSetting('theme', 'dark');
            expect(stored(legacyFile).token).toBe('');

            // And a start that finds the stale one repairs it before anything else.
            writes.failing = true;
            settings.setSetting('token', 'tok-2');
            settings.setSetting('token', '');
            writes.failing = false;
            loadFresh();
            settings.loadSettings();
            expect(stored(legacyFile).token).toBe('');
        });

        test('a settings.json that could not be set aside is left alone (see the import tests); a refused write is not a throw', () => {
            loadFresh();
            jest.spyOn(storage.legacyStorage, 'overwriteIf').mockImplementation(() => {
                throw new Error('EBUSY');
            });

            expect(() => settings.setSetting('theme', 'dark')).not.toThrow();

            expect(settings.getSetting('theme')).toBe('dark');
            expect(cat.warning).toHaveBeenCalledWith(expect.stringContaining('EBUSY'));
        });
    });

    describe('a settings.json that changed under the write', () => {
        test('is overwritten after the mirror is made again from the stored configuration', () => {
            loadFresh();
            settings.setSetting('theme', 'dark');
            const real = storage.legacyStorage.overwriteIf.bind(storage.legacyStorage);
            let conflicts = 1;
            jest.spyOn(storage.legacyStorage, 'overwriteIf').mockImplementation((expected, data) => {
                if (conflicts-- > 0) return 'conflict';
                return real(expected, data);
            });

            settings.setSetting('theme', 'light');

            expect(stored(legacyFile).theme).toBe('light');
            expect(storage.legacyStorage.overwriteIf).toHaveBeenCalledTimes(2);
        });

        test('is given up quietly after a few tries, and repaired by the next save', () => {
            loadFresh();
            settings.setSetting('theme', 'dark');
            const real = storage.legacyStorage.overwriteIf.bind(storage.legacyStorage);
            const conflict = jest.spyOn(storage.legacyStorage, 'overwriteIf').mockImplementation(() => 'conflict');

            expect(settings.setSetting('theme', 'light')).toBe(true);

            expect(conflict).toHaveBeenCalledTimes(3);
            expect(stored(legacyFile).theme).toBe('dark');
            expect(cat.info).toHaveBeenCalledWith(expect.stringContaining('tried again with the next save or start'));
            conflict.mockImplementation(real);
            settings.setSetting('language', 'lv');
            expect(stored(legacyFile)).toMatchObject({ theme: 'light', language: 'lv' });
        });

        test('a write that is refused outright is a failed mirror, not a conflict', () => {
            loadFresh();
            settings.setSetting('theme', 'dark');
            const refused = jest.spyOn(storage.legacyStorage, 'overwriteIf').mockImplementation(() => 'failed');

            settings.setSetting('theme', 'light');

            expect(refused).toHaveBeenCalledTimes(1);
            expect(cat.warning).toHaveBeenCalledWith(expect.stringContaining('could not be brought up to date'));
        });
    });

    describe('data an earlier build left: the configuration, a blanked and stale settings.json, a marker with no mirror', () => {
        const EARLIER = {
            theme: 'light',
            token: '',
            apiHeaders: {},
            lastUsername: '',
            chosenPhotosMemberId: '',
            challengeSettings: { globalDefaults: { exposure: 50 } },
        };
        const arrange = () => {
            fs.writeFileSync(
                configFile,
                JSON.stringify({
                    version: 2,
                    imported: {
                        at: '2026-10-15T10:00:00.000Z',
                        report: { refsBlocked: [] },
                        acknowledged: true,
                    },
                    app: { theme: 'dark', language: 'lv' },
                    auth: {
                        token: 'tok-secret',
                        apiHeaders: { 'x-a': 'b' },
                        lastUsername: 'me',
                        chosenPhotosMemberId: '',
                    },
                    defaults: { exposure: 80 },
                }),
            );
            fs.writeFileSync(legacyFile, JSON.stringify(EARLIER));
            fs.writeFileSync(markerFile, '{"importedAt":"2026-10-15T10:00:00.000Z"}');
        };

        test('is not imported, and the first load gives settings.json its sign-in state and settings back', () => {
            arrange();
            loadFresh();

            const loaded = settings.loadSettings();

            expect(loaded.app).toMatchObject({ theme: 'dark', language: 'lv' });
            expect(loaded.auth.token).toBe('tok-secret');
            expect(settings.getSettingsRecovery()).toBeNull();
            expect(stored(legacyFile)).toMatchObject({
                theme: 'dark',
                language: 'lv',
                token: 'tok-secret',
                apiHeaders: { 'x-a': 'b' },
                lastUsername: 'me',
                challengeSettings: { globalDefaults: { exposure: 80 } },
            });
            expect(stored(markerFile)).toHaveProperty('mirrorStartedAt');
        });

        test('keeps its import record, and reports nothing about a changed file', () => {
            arrange();
            loadFresh();

            expect(settings.getImportReport()).toEqual({
                at: '2026-10-15T10:00:00.000Z',
                refsBlocked: [],
                acknowledged: true,
            });
            expect(settings.getSettingsRecovery()).toBeNull();
            expect(stored(configFile).imported).toMatchObject({ at: '2026-10-15T10:00:00.000Z', acknowledged: true });
        });
    });

    describe('a configuration that is missing or damaged, once the mirror has written', () => {
        const mirrored = () => {
            loadFresh();
            settings.setSetting('token', 'tok-1');
            settings.setSetting('theme', 'dark');
            settings.mergeTitlePins({ '9': 'Night Sky' });
        };

        test('a missing one is restored from settings.json at the next start, with the sign-in state and no import report', () => {
            mirrored();
            fs.rmSync(configFile);

            loadFresh();
            const loaded = settings.loadSettings();

            expect(loaded.auth.token).toBe('tok-1');
            expect(loaded.app.theme).toBe('dark');
            expect(settings.getImportReport()).toBeNull();
            expect(settings.getSettingsRecovery()).toBeNull();
            expect(fs.existsSync(configFile)).toBe(true);
            expect(cat.warning).toHaveBeenCalledWith(expect.stringContaining('restored from settings.json'));
        });

        test.each([
            ['missing', () => fs.rmSync(configFile)],
            ['damaged', () => fs.writeFileSync(configFile, '{"app":{"theme":')],
        ])(
            'a %s one is restored with its rules that have a close-time condition, which settings.json keeps out of titleRules',
            (_name, lose) => {
                loadFresh();
                const rules = [
                    { title: 'Macro', match: 'exact', autoJoin: true },
                    { title: 'Evening', match: 'contains', autoJoin: false, closesAt: '18:00' },
                    { title: 'Late', match: 'contains', closesAtTimes: ['22:00', '23:30'] },
                ];
                expect(settings.saveSettings({ rules })).toBe(true);
                // A format-1 build reads titleRules: it must not see the rules whose condition it does not know.
                const mirror = stored(legacyFile) as { challengeSettings: { titleRules: Array<{ title: string }> } };
                expect(mirror.challengeSettings.titleRules.map((rule) => rule.title)).toEqual(['Macro']);
                lose();

                loadFresh();
                const loaded = settings.loadSettings();

                expect(loaded.rules).toEqual(rules);
                expect(loaded.app).not.toHaveProperty('closeTimeRules');
                expect(settings.getImportReport()).toBeNull();
            },
        );

        test('a damaged one is set aside, the settings are restored, and a notice says where the copy went', () => {
            mirrored();
            fs.writeFileSync(configFile, '{"app":{"theme":');

            loadFresh();
            const loaded = settings.loadSettings();

            const [backup] = fs.readdirSync(userData).filter((name) => name.startsWith('config.json.corrupt-'));
            expect(loaded.auth.token).toBe('tok-1');
            expect(loaded.app.theme).toBe('dark');
            expect(settings.getSettingsRecovery()).toEqual({
                code: 'settings-restored',
                path: path.join(userData, backup),
                blocking: false,
            });
            expect(fs.readFileSync(path.join(userData, backup), 'utf8')).toBe('{"app":{"theme":');
            expect(settings.getImportReport()).toBeNull();
            expect(settings.setSetting('theme', 'light')).toBe(true);
        });

        test('a damaged one is told as damaged, with defaults, when settings.json cannot be imported either', () => {
            mirrored();
            fs.writeFileSync(configFile, '{"app":{"theme":');
            fs.writeFileSync(legacyFile, '{broken');

            loadFresh();
            const loaded = settings.loadSettings();

            expect(loaded).toEqual(settings.getDefaultSettings());
            expect(settings.getSettingsRecovery()?.code).toBe('settings-corrupt');
            expect(fs.readFileSync(legacyFile, 'utf8')).toBe('{broken');
        });

        test('a damaged one is told as damaged, with defaults, when there is no settings.json', () => {
            mirrored();
            fs.writeFileSync(configFile, '{"app":{"theme":');
            fs.rmSync(legacyFile);

            loadFresh();

            expect(settings.loadSettings()).toEqual(settings.getDefaultSettings());
            expect(settings.getSettingsRecovery()?.code).toBe('settings-corrupt');
        });

        test('a configuration another process saved while the damaged one was set aside is the one in use', () => {
            mirrored();
            fs.writeFileSync(configFile, '{"app":{"theme":');
            loadFresh(() => {
                jest.doMock('../../../src/ts/lockWait', () => ({
                    acquireWithin: () => {
                        fs.writeFileSync(configFile, JSON.stringify({ app: { theme: 'light' } }));
                        return { ok: true, release: () => undefined };
                    },
                }));
            });

            const loaded = settings.loadSettings();

            expect(loaded.app.theme).toBe('light');
            expect(settings.getSettingsRecovery()?.code).toBe('settings-restored');
        });

        test('a configuration another process saved meanwhile that cannot be read is told as damaged, with defaults', () => {
            mirrored();
            fs.writeFileSync(configFile, '{"app":{"theme":');
            loadFresh(() => {
                jest.doMock('../../../src/ts/lockWait', () => ({
                    acquireWithin: () => {
                        fs.writeFileSync(configFile, '[1]');
                        return { ok: true, release: () => undefined };
                    },
                }));
            });

            expect(settings.loadSettings()).toEqual(settings.getDefaultSettings());

            expect(settings.getSettingsRecovery()?.code).toBe('settings-corrupt');
        });

        test('before the stores can be read (the Android window before it hydrates) nothing is restored and nothing is said; the next read restores', () => {
            mirrored();
            fs.rmSync(configFile);
            loadFresh();
            const loadedNow = jest.spyOn(storage.legacyStorage, 'isLoaded').mockReturnValue(false);

            settings.loadSettings();

            expect(settings.getSettingsRecovery()).toBeNull();
            expect(fs.existsSync(configFile)).toBe(false);

            loadedNow.mockRestore();
            settings.loadSettings();

            expect(fs.existsSync(configFile)).toBe(true);
        });

        test('a restore from a lost configuration gives the About-data report back, and what was acknowledged stays so', () => {
            fs.writeFileSync(legacyFile, RAW);
            loadFresh();
            settings.loadSettings();
            const record = settings.getImportReport();
            expect(record).toMatchObject({ acknowledged: false });
            expect(settings.acknowledgeImportReport()).toBe(true);
            fs.rmSync(configFile);

            loadFresh();
            settings.loadSettings();

            expect(settings.getImportReport()).toEqual({ ...record, acknowledged: true });
        });

        test('a damaged configuration restored once the stores can be read tells so: the notice reflects the outcome', () => {
            mirrored();
            fs.writeFileSync(configFile, '{"app":{"theme":');
            loadFresh();
            const loadedNow = jest.spyOn(storage.legacyStorage, 'isLoaded').mockReturnValue(false);

            // The first load cannot restore (Android: before the window has read settings.json): defaults, told as damaged.
            settings.loadSettings();
            expect(settings.getSettingsRecovery()?.code).toBe('settings-corrupt');

            loadedNow.mockReturnValue(true);
            const loaded = settings.loadSettings();

            expect(loaded.auth.token).toBe('tok-1');
            expect(settings.getSettingsRecovery()?.code).toBe('settings-restored');
        });

        test('re-importing after a restore replaces the notice', () => {
            mirrored();
            fs.writeFileSync(configFile, '{"app":{"theme":');
            loadFresh();
            settings.loadSettings();
            expect(settings.getSettingsRecovery()?.code).toBe('settings-restored');

            expect(settings.reimportFromV1()).toBe(true);

            expect(settings.getSettingsRecovery()).toBeNull();
            expect(settings.loadSettings().auth.token).toBe('tok-1');
        });
    });

    test.each([
        ['an Error', () => new Error('EIO'), 'EIO'],
        ['a value that carries no message', () => 'weird', 'unknown error'],
    ])(
        'the mirror never throws into a save: an unexpected failure inside it (%s) is a warning',
        (_name, thrown, said) => {
            loadFresh();
            jest.spyOn(storage.storage, 'peekRaw').mockImplementation(() => {
                throw thrown();
            });

            expect(settings.setSetting('theme', 'dark')).toBe(true);

            expect(cat.warning).toHaveBeenCalledWith(expect.stringContaining(said));
        },
    );

    describe('the marker that says the mirror has started', () => {
        test.each([
            ['is not JSON', '{broken'],
            ['is not an object', '[1]'],
        ])(
            'a marker that %s says it has not: no restore, and a save writes the mirror without recording it',
            (_name, text) => {
                fs.writeFileSync(markerFile, text);
                loadFresh();
                expect(settings.loadSettings()).toEqual(settings.getDefaultSettings());

                expect(settings.setSetting('theme', 'dark')).toBe(true);

                expect(stored(legacyFile)).toMatchObject({ theme: 'dark' });
                expect(fs.readFileSync(markerFile, 'utf8')).toBe(text);
            },
        );

        test('is recorded once: a marker that holds it is not rewritten', () => {
            loadFresh();
            settings.setSetting('theme', 'dark');
            const { mirrorStartedAt } = stored(markerFile);

            settings.setSetting('theme', 'light');

            expect(stored(markerFile).mirrorStartedAt).toBe(mirrorStartedAt);
        });
    });

    describe('the copy kept of a settings.json that could not be imported', () => {
        test.each([
            ['an Error', () => new Error('ENOSPC'), 'ENOSPC'],
            ['a value that carries no message', () => 'weird', 'unknown error'],
        ])('that cannot be written (%s) says why', (_name, thrown, said) => {
            loadFresh();
            jest.spyOn(fs, 'openSync').mockImplementation(() => {
                throw thrown();
            });

            expect(storage.legacyStorage.keepUnimportable('{broken')).toEqual({ ok: false, error: said });
        });
    });

    describe('the compare-and-overwrite of a settings file', () => {
        test('refuses a text the file no longer holds, and says nothing of what it held', () => {
            loadFresh();
            fs.writeFileSync(legacyFile, '{"a":1}');

            expect(storage.legacyStorage.overwriteIf('{"a":2}', '{"b":1}')).toBe('conflict');
            expect(storage.legacyStorage.overwriteIf(null, '{"b":1}')).toBe('conflict');

            expect(fs.readFileSync(legacyFile, 'utf8')).toBe('{"a":1}');
            expect(storage.legacyStorage.overwriteIf('{"a":1}', '{"b":1}')).toBe('written');
        });

        test('does nothing while local data is being deleted', async () => {
            loadFresh();
            await storage.discardPendingWrites();

            expect(storage.legacyStorage.overwriteIf(null, '{"b":1}')).toBe('failed');
            await expect(storage.legacyStorage.casStored(null, '{"b":1}')).rejects.toThrow('writes are refused');
        });
    });
});
