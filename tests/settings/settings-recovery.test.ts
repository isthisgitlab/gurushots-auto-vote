/**
 * Corrupt, unreadable and un-migratable settings files, against a real temp
 * directory: a file that does not parse is set aside once and defaults apply
 * (saves then work); a file that cannot be read, or cannot be migrated, is never
 * overwritten while that lasts. Saves replace the file atomically.
 */

// A partial mock of the real fs (a builtin's exports are not spy-able as is), so
// a read failure can be injected while every other call stays real.
jest.mock('node:fs', () => {
    const actual = jest.requireActual<typeof import('node:fs')>('node:fs');
    return { __esModule: true, ...actual, default: actual };
});
jest.unmock('path');
jest.unmock('node:path');
jest.mock('../../src/ts/runtime', () => ({
    __esModule: true,
    ...jest.requireActual<typeof import('../../src/ts/runtime')>('../../src/ts/runtime'),
}));
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

type CatDouble = jest.Mocked<Pick<CategoryLogger, 'info' | 'error' | 'debug' | 'success' | 'warning'>>;

describe('settings recovery (real fs)', () => {
    let root: string;
    let userData: string;
    let settingsFile: string;
    let settings: typeof settingsModule;
    let cat: CatDouble;

    // Each test gets its own module graph: the recovery state lives in the settings module.
    const loadFresh = (migrationsOverride?: () => never) => {
        jest.isolateModules(() => {
            const runtime = require('../../src/ts/runtime') as typeof runtimeModule;
            jest.spyOn(runtime, 'getAppUserDataPath').mockReturnValue(userData);
            if (migrationsOverride) {
                jest.doMock('../../src/ts/settings/migrations', () => ({
                    ...jest.requireActual<typeof import('../../src/ts/settings/migrations')>(
                        '../../src/ts/settings/migrations',
                    ),
                    runMigrations: migrationsOverride,
                }));
            }
            settings = require('../../src/ts/settings') as typeof settingsModule;
            cat = invalid<typeof loggerModule & { __cat: CatDouble }>(
                require('../../src/ts/logger') as typeof loggerModule,
            ).__cat;
        });
        jest.dontMock('../../src/ts/settings/migrations');
    };

    const backups = () => fs.readdirSync(userData).filter((name) => name.startsWith('settings.json.corrupt-'));

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'gs-recovery-'));
        userData = path.join(root, 'userData');
        fs.mkdirSync(userData);
        settingsFile = path.join(userData, 'settings.json');
    });

    afterEach(() => {
        jest.restoreAllMocks();
        fs.rmSync(root, { recursive: true, force: true });
    });

    describe('a file that does not parse', () => {
        test('a truncated file is set aside once; defaults apply; the next save and a token write work', () => {
            const truncated = '{"theme":"dark","token":"abc","challengeSettings":{"globalDefaults":{"expo';
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
            });

            // Saves work normally, including the token write a login makes.
            expect(settings.setSetting('theme', 'dark')).toBe(true);
            expect(settings.setSetting('token', 'new-token')).toBe(true);
            const saved = JSON.parse(fs.readFileSync(settingsFile, 'utf8')) as { theme: string; token: string };
            expect(saved.theme).toBe('dark');
            expect(saved.token).toBe('new-token');
            expect(settings.loadSettings().token).toBe('new-token');
            expect(backups()).toHaveLength(1);
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
            expect(settings.saveSettings({ theme: 'dark' })).toBe(true);
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
            expect(settings.saveSettings({ theme: 'dark' })).toBe(false);

            expect(fs.readFileSync(settingsFile, 'utf8')).toBe('{not json');
            expect(settings.getSettingsRecovery()).toEqual({ code: 'settings-unreadable', path: settingsFile });
        });
    });

    describe('a file that cannot be read', () => {
        const original = JSON.stringify({ theme: 'dark', token: 'keep-me', challengeSettings: { globalDefaults: {} } });

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
            expect(settings.saveSettings({ theme: 'light' })).toBe(false);
            expect(settings.setSetting('token', 'planted')).toBe(false);
            expect(settings.cleanupObsoleteSettings()).toBeUndefined();

            expect(settings.getSettingsRecovery()).toEqual({ code: 'settings-unreadable', path: settingsFile });
            expect(cat.error).toHaveBeenCalledWith(expect.stringContaining('EACCES'));
            expect(backups()).toEqual([]);
            failing.mockRestore();
            expect(fs.readFileSync(settingsFile, 'utf8')).toBe(original);

            // The error is gone: the next load reads the file, drops the refusal, and saves work again.
            expect(settings.loadSettings().token).toBe('keep-me');
            expect(settings.getSettingsRecovery()).toBeNull();
            expect(settings.saveSettings({ theme: 'light' })).toBe(true);
            expect((JSON.parse(fs.readFileSync(settingsFile, 'utf8')) as { token: string }).token).toBe('keep-me');
        });
    });

    describe('a file that parses but cannot be migrated', () => {
        const original = JSON.stringify({ theme: 'dark', token: 'keep-me' });

        test('is left as it is, not moved aside, and saves are refused', () => {
            fs.writeFileSync(settingsFile, original);
            loadFresh(() => {
                throw new Error('migration exploded');
            });

            expect(settings.loadSettings()).toEqual(settings.getDefaultSettings());
            expect(settings.saveSettings({ theme: 'light' })).toBe(false);

            expect(fs.readFileSync(settingsFile, 'utf8')).toBe(original);
            expect(backups()).toEqual([]);
            expect(settings.getSettingsRecovery()).toEqual({ code: 'settings-migration-failed', path: settingsFile });
            expect(cat.error).toHaveBeenCalledWith(expect.stringContaining('migration exploded'));
        });

        test('a migration failure with no message is still reported', () => {
            fs.writeFileSync(settingsFile, original);
            loadFresh(() => {
                throw null;
            });

            settings.loadSettings();

            expect(cat.error).toHaveBeenCalledWith(expect.stringContaining('unknown error'));
        });
    });

    describe('a login saved by the CLI', () => {
        test('survives the next process reading the settings, with Stay Logged In off (login, then status)', () => {
            loadFresh();
            expect(settings.setSetting('stayLoggedIn', false)).toBe(true);
            expect(settings.setSetting('token', 'cli-token')).toBe(true);

            loadFresh();

            expect(settings.loadSettings().token).toBe('cli-token');
            expect(settings.getSetting('token')).toBe('cli-token');
            expect(JSON.parse(fs.readFileSync(settingsFile, 'utf8')) as { token: string }).toEqual(
                expect.objectContaining({ token: 'cli-token' }),
            );
        });
    });

    describe('atomic saves', () => {
        test('a save replaces the file, leaves no temp file and keeps it owner-only', () => {
            loadFresh();
            expect(settings.setSetting('theme', 'dark')).toBe(true);
            const inode = fs.statSync(settingsFile).ino;
            expect(settings.setSetting('theme', 'light')).toBe(true);

            expect(fs.readdirSync(userData)).toEqual(['settings.json']);
            expect(fs.statSync(settingsFile).ino).not.toBe(inode);
            if (process.platform !== 'win32') expect(fs.statSync(settingsFile).mode & 0o777).toBe(0o600);
            expect((JSON.parse(fs.readFileSync(settingsFile, 'utf8')) as { theme: string }).theme).toBe('light');
        });

        test('temp files an earlier crash left beside the settings are swept on the first write', () => {
            loadFresh();
            const stale = path.join(userData, 'settings.json.123.deadbeef.tmp');
            fs.writeFileSync(stale, 'half');
            const old = new Date(Date.now() - 10 * 60_000);
            fs.utimesSync(stale, old, old);

            expect(settings.setSetting('theme', 'dark')).toBe(true);

            expect(fs.existsSync(stale)).toBe(false);
        });
    });
});
