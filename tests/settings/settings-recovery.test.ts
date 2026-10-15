/**
 * Corrupt and unreadable configuration files, against a real temp directory: a file that does not parse is set aside
 * once and defaults apply (saves then work), and a 1.x settings.json beside it is never imported over that; a file
 * that cannot be read is never overwritten while that lasts. Saves replace the file atomically.
 */

// A partial mock of the real fs (a builtin's exports are not spy-able as is), so
// a read failure can be injected while every other call stays real.
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
import type { CategoryLogger } from '../../src/ts/logger';
import { invalid } from '../helpers/invalid';
import { isShape, isString, parseJsonAs, parseJsonObject } from '../helpers/parseJson';

type CatDouble = jest.Mocked<Pick<CategoryLogger, 'info' | 'error' | 'debug' | 'success' | 'warning'>>;

describe('settings recovery (real fs)', () => {
    let root: string;
    let userData: string;
    let settingsFile: string;
    let legacyFile: string;
    let settings: typeof settingsModule;
    let cat: CatDouble;

    // Each test gets its own module graph: the recovery state lives in the settings module.
    const loadFresh = () => {
        jest.isolateModules(() => {
            // A factory, not a spy: `jest.restoreAllMocks()` must not send the module back to the real user-data folder.
            const actualRuntime = jest.requireActual<typeof runtimeModule>('../../src/ts/runtime');
            jest.doMock('../../src/ts/runtime', () => ({
                __esModule: true,
                ...actualRuntime,
                getAppUserDataPath: () => userData,
            }));
            settings = require('../../src/ts/settings') as typeof settingsModule;
            cat = invalid<typeof loggerModule & { __cat: CatDouble }>(
                require('../../src/ts/logger') as typeof loggerModule,
            ).__cat;
        });
    };

    const backups = () => fs.readdirSync(userData).filter((name) => name.startsWith('config.json.corrupt-'));

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'gs-recovery-'));
        userData = path.join(root, 'userData');
        fs.mkdirSync(userData);
        settingsFile = path.join(userData, 'config.json');
        legacyFile = path.join(userData, 'settings.json');
    });

    afterEach(() => {
        jest.restoreAllMocks();
        jest.dontMock('../../src/ts/runtime');
        fs.rmSync(root, { recursive: true, force: true });
    });

    describe('a file that does not parse', () => {
        test('a truncated file is set aside once; defaults apply; the next save and a token write work', () => {
            const truncated = '{"app":{"theme":"dark"},"auth":{"token":"abc"},"defaults":{"expo';
            fs.writeFileSync(settingsFile, truncated);
            loadFresh();

            expect(settings.loadSettings()).toEqual(settings.getDefaultSettings());

            // The text went to a backup beside the file, the file itself is gone, and it was said once.
            const [backup] = backups();
            expect(backups()).toHaveLength(1);
            expect(fs.readFileSync(path.join(userData, backup), 'utf8')).toBe(truncated);
            expect(fs.existsSync(settingsFile)).toBe(false);
            expect(cat.error).toHaveBeenCalledTimes(1);
            expect(cat.error).toHaveBeenCalledWith(expect.stringContaining(path.join(userData, backup)));
            expect(settings.getSettingsRecovery()).toEqual({
                code: 'settings-corrupt',
                path: path.join(userData, backup),
                blocking: false,
            });

            // Saves work normally, including the token write a login makes.
            expect(settings.setSetting('theme', 'dark')).toBe(true);
            expect(settings.setSetting('token', 'new-token')).toBe(true);
            const saved = parseJsonAs(
                fs.readFileSync(settingsFile, 'utf8'),
                isShape<{ app: { theme: string }; auth: { token: string } }>({
                    app: isShape<{ theme: string }>({ theme: isString }),
                    auth: isShape<{ token: string }>({ token: isString }),
                }),
            );
            expect(saved.app.theme).toBe('dark');
            expect(saved.auth.token).toBe('new-token');
            expect(settings.loadSettings().auth.token).toBe('new-token');
            expect(backups()).toHaveLength(1);
        });

        test('a settings.json beside it is not imported over it, now or at the next start', () => {
            const oneX = JSON.stringify({ theme: 'dark', timezone: 'UTC' });
            fs.writeFileSync(legacyFile, oneX);
            fs.writeFileSync(settingsFile, '{not json');
            loadFresh();

            expect(settings.loadSettings()).toEqual(settings.getDefaultSettings());
            expect(settings.getSettingsRecovery()?.code).toBe('settings-corrupt');
            expect(fs.existsSync(settingsFile)).toBe(false);

            // A later start finds no configuration, only the set-aside copy: the glob keeps the import away.
            loadFresh();
            expect(settings.loadSettings()).toEqual(settings.getDefaultSettings());
            expect(fs.existsSync(settingsFile)).toBe(false);
            expect(fs.readFileSync(legacyFile, 'utf8')).toBe(oneX);
        });

        test('reading it again does not make another backup or say it again', () => {
            fs.writeFileSync(settingsFile, '{not json');
            loadFresh();
            settings.loadSettings();
            // The same text handed back (a store that keeps it) is not moved twice.
            fs.writeFileSync(settingsFile, '{not json');
            settings.loadSettings();
            settings.loadSettings();

            expect(backups()).toHaveLength(1);
            expect(cat.error).toHaveBeenCalledTimes(1);
        });

        test.each([
            ['null', 'null'],
            ['an array', '[1,2]'],
            ['a number', '5'],
            ['a string', '"settings"'],
            ['a boolean', 'true'],
        ])('a root that is %s is set aside like a file that does not parse', (_name, text) => {
            fs.writeFileSync(settingsFile, text);
            loadFresh();

            expect(settings.loadSettings()).toEqual(settings.getDefaultSettings());

            expect(backups()).toHaveLength(1);
            expect(cat.error).toHaveBeenCalledWith(expect.stringContaining('its root is not an object'));
            expect(settings.saveAppSettings({ theme: 'dark' })).toBe(true);
        });

        test('a move that fails with no message is still reported', () => {
            fs.writeFileSync(settingsFile, '{not json');
            loadFresh();
            jest.spyOn(fs, 'renameSync').mockImplementation(() => {
                throw null;
            });

            settings.loadSettings();

            expect(cat.error).toHaveBeenCalledWith(expect.stringContaining('could not be set aside: unknown error'));
        });

        test('a file that cannot be moved aside is left alone and saves are refused', () => {
            fs.writeFileSync(settingsFile, '{not json');
            loadFresh();
            jest.spyOn(fs, 'renameSync').mockImplementation(() => {
                throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
            });

            expect(settings.loadSettings()).toEqual(settings.getDefaultSettings());
            expect(settings.saveAppSettings({ theme: 'dark' })).toBe(false);

            expect(fs.readFileSync(settingsFile, 'utf8')).toBe('{not json');
            expect(settings.getSettingsRecovery()).toEqual({
                code: 'settings-unreadable',
                path: settingsFile,
                blocking: true,
            });
        });
    });

    describe('a file that cannot be read', () => {
        const original = JSON.stringify({ app: { theme: 'dark' }, auth: { token: 'keep-me' } });

        test('a read error that carries no message is still reported', () => {
            fs.writeFileSync(settingsFile, original);
            loadFresh();
            jest.spyOn(fs, 'readFileSync').mockImplementation(() => {
                throw null;
            });

            settings.loadSettings();

            expect(cat.error).toHaveBeenCalledWith(expect.stringContaining('unknown error'));
            expect(settings.getSettingsRecovery()?.code).toBe('settings-unreadable');
        });

        test('saves are refused and the file is never overwritten while the read error lasts', () => {
            fs.writeFileSync(settingsFile, original);
            loadFresh();
            const realRead = fs.readFileSync;
            const failing = jest.spyOn(fs, 'readFileSync').mockImplementation(
                invalid<typeof fs.readFileSync>((file: fs.PathOrFileDescriptor) => {
                    if (file === settingsFile)
                        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
                    return realRead(file, 'utf8');
                }),
            );

            expect(settings.loadSettings()).toEqual(settings.getDefaultSettings());
            expect(settings.saveAppSettings({ theme: 'light' })).toBe(false);
            expect(settings.setSetting('token', 'planted')).toBe(false);

            expect(settings.getSettingsRecovery()).toEqual({
                code: 'settings-unreadable',
                path: settingsFile,
                blocking: true,
            });
            expect(cat.error).toHaveBeenCalledWith(expect.stringContaining('EACCES'));
            expect(backups()).toEqual([]);
            failing.mockRestore();
            expect(fs.readFileSync(settingsFile, 'utf8')).toBe(original);

            // The error is gone: the next load reads the file, drops the refusal, and saves work again.
            expect(settings.loadSettings().auth.token).toBe('keep-me');
            expect(settings.getSettingsRecovery()).toBeNull();
            expect(settings.saveAppSettings({ theme: 'light' })).toBe(true);
            expect(parseJsonObject(fs.readFileSync(settingsFile, 'utf8')).auth).toEqual(
                expect.objectContaining({ token: 'keep-me' }),
            );
        });
    });

    describe('a login saved by the CLI', () => {
        test('survives the next process reading the settings, with Stay Logged In off (login, then status)', () => {
            loadFresh();
            expect(settings.setSetting('stayLoggedIn', false)).toBe(true);
            expect(settings.setSetting('token', 'cli-token')).toBe(true);

            loadFresh();

            expect(settings.loadSettings().auth.token).toBe('cli-token');
            expect(settings.getSetting('token')).toBe('cli-token');
            expect(parseJsonObject(fs.readFileSync(settingsFile, 'utf8')).auth).toEqual(
                expect.objectContaining({ token: 'cli-token' }),
            );
        });
    });

    describe('atomic saves', () => {
        test('a save replaces the file, leaves no temp file and keeps it owner-only', () => {
            loadFresh();
            expect(settings.setSetting('theme', 'dark')).toBe(true);
            // A hard link outside userData keeps the file that was there: a write in place would change it too.
            const before = path.join(root, 'before.json');
            fs.linkSync(settingsFile, before);
            expect(settings.setSetting('theme', 'light')).toBe(true);

            expect(fs.readdirSync(userData).sort()).toEqual(['config.json', 'v2-import.json']);
            expect(parseJsonObject(fs.readFileSync(before, 'utf8')).app).toEqual(
                expect.objectContaining({ theme: 'dark' }),
            );
            if (process.platform !== 'win32') expect(fs.statSync(settingsFile).mode & 0o777).toBe(0o600);
            expect(parseJsonObject(fs.readFileSync(settingsFile, 'utf8')).app).toEqual(
                expect.objectContaining({ theme: 'light' }),
            );
        });

        test('temp files an earlier crash left beside the settings are swept on the first write', () => {
            loadFresh();
            const stale = path.join(userData, 'config.json.123.deadbeef.tmp');
            fs.writeFileSync(stale, 'half');
            const old = new Date(Date.now() - 10 * 60_000);
            fs.utimesSync(stale, old, old);

            expect(settings.setSetting('theme', 'dark')).toBe(true);

            expect(fs.existsSync(stale)).toBe(false);
        });
    });
});
