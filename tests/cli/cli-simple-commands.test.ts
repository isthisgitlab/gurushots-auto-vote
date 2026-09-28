/**
 * Unit tests for the thin CLI command modules: auth (login / logout),
 * bankroll, join (discover / join), update (check-updates) and logs. Each
 * module is a shell over a shared service or IPC handler, so those are
 * mocked and the tests assert what gets printed and dispatched.
 */

jest.mock('../../src/js/logger', () => {
    const calls: { level: string; msg: unknown; data?: unknown }[] = [];
    const rec = (level: string) => (msg: unknown, data?: unknown) => calls.push({ level, msg, data });
    const cat = {
        info: rec('info'),
        error: rec('error'),
        success: rec('success'),
        warning: rec('warning'),
        debug: rec('debug'),
        startOperation: rec('startOperation'),
        endOperation: (id: unknown, ok: unknown, err: unknown) =>
            calls.push({ level: 'endOperation', msg: ok, data: err }),
    };
    return {
        __calls: calls,
        withCategory: jest.fn(() => cat),
        getLogFile: jest.fn(() => '/logs/app.log'),
        getErrorLogFile: jest.fn(() => '/logs/error.log'),
        getApiLogFile: jest.fn(() => '/logs/api.log'),
        getSettingsLogFile: jest.fn(() => '/logs/settings.log'),
    };
});

jest.mock('../../src/js/settings', () => ({
    loadSettings: jest.fn(() => ({ mock: false })),
    setSetting: jest.fn(),
}));

jest.mock('../../src/js/apiFactory', () => {
    const middleware = { isAuthenticated: jest.fn(() => true), cliLogin: jest.fn() };
    return { __mw: middleware, getMiddleware: jest.fn(() => middleware), refreshApi: jest.fn() };
});

jest.mock('../../src/js/services/auth', () => ({ clearAuthToken: jest.fn() }));

jest.mock('../../src/js/cli/prompts', () => ({
    createReadlineInterface: jest.fn(),
    askYesNo: jest.fn(),
    askInput: jest.fn(),
    askSecret: jest.fn(),
}));

jest.mock('../../src/js/ipc/actions.handlers', () => {
    const handlers = { 'get-bankroll': jest.fn(), 'get-member-challenges': jest.fn(), 'join-challenge': jest.fn() };
    return { __handlers: handlers, buildHandlers: jest.fn(() => handlers) };
});

jest.mock('../../src/js/services/UpdateChecker', () => ({
    checkForUpdates: jest.fn(),
    getReleasesUrl: jest.fn(() => 'https://releases'),
}));

const mockHasBundledModel = jest.fn(async () => true);
jest.mock('../../src/js/services/visionVerifier', () => ({ hasBundledModel: mockHasBundledModel }));

import fsModule = require('node:fs');
const fs = jest.mocked(fsModule);
import loggerModule = require('../../src/js/logger');
const logger = jest.mocked(
    invalid<typeof loggerModule & { __calls: { level: string; msg: unknown; data?: unknown }[] }>(loggerModule),
);
import settingsModule = require('../../src/js/settings');
const settings = jest.mocked(settingsModule);
import apiFactoryModule = require('../../src/js/apiFactory');
type Middleware = ReturnType<typeof apiFactoryModule.getMiddleware>;
const apiFactory = jest.mocked(
    invalid<
        typeof apiFactoryModule & {
            __mw: {
                isAuthenticated: jest.MockedFunction<Middleware['isAuthenticated']>;
                cliLogin: jest.MockedFunction<Middleware['cliLogin']>;
            };
        }
    >(apiFactoryModule),
);
const { clearAuthToken } = jest.mocked(require('../../src/js/services/auth') as typeof authModule);
import promptsModule = require('../../src/js/cli/prompts');
const prompts = jest.mocked(promptsModule);
// The handler-module mocks expose their jest.fn table for the assertions.
type HandlersMock = {
    __handlers: jest.Mocked<
        Pick<
            ReturnType<typeof actionsHandlersModule.buildHandlers>,
            'get-bankroll' | 'get-member-challenges' | 'join-challenge'
        >
    >;
};
const handlers = invalid<HandlersMock>(require('../../src/js/ipc/actions.handlers')).__handlers;
import updateCheckerModule = require('../../src/js/services/UpdateChecker');
const updateChecker = jest.mocked(updateCheckerModule);
import type * as authModule from '../../src/js/services/auth';
import type * as actionsHandlersModule from '../../src/js/ipc/actions.handlers';
import type * as authCommandsModule from '../../src/js/cli/commands/auth';
import type * as bankrollModule from '../../src/js/cli/commands/bankroll';
import type * as joinModule from '../../src/js/cli/commands/join';
import type * as updateModule from '../../src/js/cli/commands/update';
import type * as logsModule from '../../src/js/cli/commands/logs';
import { invalid } from '../helpers/invalid';
const pkg = jest.requireActual<typeof import('../../package.json')>('../../package.json');

const { handleLogin, handleLogout } = require('../../src/js/cli/commands/auth') as typeof authCommandsModule;
const { showBankroll } = require('../../src/js/cli/commands/bankroll') as typeof bankrollModule;
const { showDiscover, joinChallengeCmd } = require('../../src/js/cli/commands/join') as typeof joinModule;
const { checkUpdates } = require('../../src/js/cli/commands/update') as typeof updateModule;
const { showLogs } = require('../../src/js/cli/commands/logs') as typeof logsModule;

const msgs = (level: string) => logger.__calls.filter((c) => c.level === level).map((c) => String(c.msg));
const all = () => logger.__calls.map((c) => String(c.msg)).join('\n');

let exitSpy: jest.SpiedFunction<typeof process.exit>;
beforeEach(() => {
    logger.__calls.length = 0;
    // mockReset so queued *Once values never leak between tests under --randomize.
    [
        ...Object.values(handlers),
        prompts.askYesNo,
        apiFactory.__mw.cliLogin,
        updateChecker.checkForUpdates,
        clearAuthToken,
    ].forEach((m) => m.mockReset());
    apiFactory.__mw.isAuthenticated.mockReturnValue(true);
    exitSpy = jest.spyOn(process, 'exit').mockImplementation((code) => {
        throw new Error(`exit:${code}`);
    });
});
afterEach(() => exitSpy.mockRestore());

describe('auth: login', () => {
    const ttyDesc = {
        in: Object.getOwnPropertyDescriptor(process.stdin, 'isTTY'),
        out: Object.getOwnPropertyDescriptor(process.stdout, 'isTTY'),
    };
    const setTTY = (stdin: boolean, stdout: boolean) => {
        Object.defineProperty(process.stdin, 'isTTY', { value: stdin, configurable: true, writable: true });
        Object.defineProperty(process.stdout, 'isTTY', { value: stdout, configurable: true, writable: true });
    };
    const restore = (stream: { isTTY?: boolean }, desc: PropertyDescriptor | undefined) => {
        if (desc) Object.defineProperty(stream, 'isTTY', desc);
        else delete stream.isTTY;
    };
    let rl: { close: jest.MockedFunction<ReturnType<typeof promptsModule.createReadlineInterface>['close']> };
    beforeEach(() => {
        setTTY(true, true);
        rl = { close: jest.fn() };
        prompts.createReadlineInterface.mockReturnValue(invalid(rl));
        prompts.askInput.mockResolvedValue('me@x.io');
        prompts.askSecret.mockResolvedValue('pw');
        settings.loadSettings.mockReturnValue(invalid({ mock: false }));
    });
    afterEach(() => {
        restore(process.stdin, ttyDesc.in);
        restore(process.stdout, ttyDesc.out);
    });

    test.each([
        [false, true],
        [true, false],
    ])('refuses a non-terminal session (stdin TTY=%p, stdout TTY=%p)', async (inTTY, outTTY) => {
        setTTY(inTTY, outTTY);
        await handleLogin();
        expect(prompts.createReadlineInterface).not.toHaveBeenCalled();
        expect(msgs('error')[0]).toMatch(/requires a terminal/);
    });

    test('keeps the mode and saves the token on success', async () => {
        prompts.askYesNo.mockResolvedValueOnce(false);
        apiFactory.__mw.cliLogin.mockResolvedValue(invalid({ success: true }));
        await handleLogin();
        expect(msgs('info')).toContain('Current mode: REAL');
        expect(settings.setSetting).not.toHaveBeenCalled();
        expect(apiFactory.refreshApi).toHaveBeenCalled();
        expect(apiFactory.__mw.cliLogin).toHaveBeenCalledWith('me@x.io', 'pw');
        expect(msgs('success')).toEqual(['Token saved for REAL mode']);
        expect(rl.close).toHaveBeenCalled();
    });

    test('switches to MOCK mode when asked', async () => {
        prompts.askYesNo.mockResolvedValueOnce(true).mockResolvedValueOnce(true);
        apiFactory.__mw.cliLogin.mockResolvedValue(invalid({ success: true }));
        await handleLogin();
        expect(settings.setSetting).toHaveBeenCalledWith('mock', true);
        expect(msgs('success')).toEqual(['Mode changed to: MOCK', 'Token saved for MOCK mode']);
    });

    test('switches from MOCK to REAL mode and reports a failed login', async () => {
        settings.loadSettings.mockReturnValue(invalid({ mock: true }));
        prompts.askYesNo.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
        apiFactory.__mw.cliLogin.mockResolvedValue({ success: false, error: 'bad creds' });
        await handleLogin();
        expect(msgs('info')).toContain('Current mode: MOCK');
        expect(settings.setSetting).toHaveBeenCalledWith('mock', false);
        expect(msgs('success')).toEqual(['Mode changed to: REAL']);
        expect(logger.__calls.find((c) => c.level === 'endOperation')!.data).toBe('bad creds');
    });

    test('a failed login without an error message falls back to "Unknown error"', async () => {
        prompts.askYesNo.mockResolvedValueOnce(false);
        apiFactory.__mw.cliLogin.mockResolvedValue(invalid({ success: false }));
        await handleLogin();
        expect(logger.__calls.find((c) => c.level === 'endOperation')!.data).toBe('Unknown error');
    });

    test('a thrown error is logged and the readline is still closed', async () => {
        prompts.askYesNo.mockRejectedValueOnce(new Error('stdin closed'));
        await handleLogin();
        expect(msgs('error')).toEqual(['Login error']);
        expect(rl.close).toHaveBeenCalled();
    });
});

describe('auth: logout', () => {
    test('reports a cleared token', async () => {
        clearAuthToken.mockResolvedValue(true);
        await handleLogout();
        expect(msgs('success')).toEqual(['Logged out — token cleared']);
    });

    test('reports already logged out', async () => {
        clearAuthToken.mockResolvedValue(false);
        await handleLogout();
        expect(msgs('info')).toEqual(['Already logged out — no token was set']);
    });
});

describe('bankroll', () => {
    test('requires authentication', async () => {
        apiFactory.__mw.isAuthenticated.mockReturnValue(false);
        await showBankroll();
        expect(handlers['get-bankroll']).not.toHaveBeenCalled();
    });

    test('prints every balance', async () => {
        handlers['get-bankroll'].mockResolvedValue({ success: true, keys: 1, swaps: 2, fills: 3, coins: 4 });
        await showBankroll();
        expect(handlers['get-bankroll']).toHaveBeenCalledWith(null);
        const out = all();
        expect(out).toContain('Keys:  1');
        expect(out).toContain('Swaps: 2');
        expect(out).toContain('Fills: 3');
        expect(out).toContain('Coins: 4');
    });

    test.each([
        [{ success: false, error: 'boom' }, '(unavailable — boom)'],
        [{ success: false }, '(unavailable — could not read balance)'],
        [undefined, '(unavailable — could not read balance)'],
    ])('never prints a zero balance on a failed read (%p)', async (result, line) => {
        handlers['get-bankroll'].mockResolvedValue(invalid(result));
        await showBankroll();
        expect(msgs('info')).toContain(`  ${line}`);
        expect(all()).not.toContain('Keys');
    });
});

describe('discover', () => {
    test('requires authentication', async () => {
        apiFactory.__mw.isAuthenticated.mockReturnValue(false);
        await showDiscover();
        expect(handlers['get-member-challenges']).not.toHaveBeenCalled();
    });

    test.each([
        [{ success: false, error: 'down' }, '  (unavailable — down)'],
        [null, '  (unavailable — could not list challenges)'],
        [{ success: true, items: [] }, '  None'],
        [{ success: true, items: 'nope' }, '  None'],
    ])('reports %p', async (result, line) => {
        handlers['get-member-challenges'].mockResolvedValue(invalid(result));
        await showDiscover();
        expect(handlers['get-member-challenges']).toHaveBeenCalledWith(null, 'open');
        expect(msgs('info')).toContain(line);
    });

    test('lists challenges with cost, name fallbacks and join hints', async () => {
        handlers['get-member-challenges'].mockResolvedValue(
            invalid({
                success: true,
                items: [
                    { id: 1, title: 'Sunset', type: 'flash', join_coins: 5 },
                    { id: 2, url: 'dogs', join_coins: 0 },
                    { id: 3 },
                    null,
                ],
            }),
        );
        await showDiscover();
        const info = msgs('info');
        expect(info).toContain('  • [1] Sunset (flash) — 5 coins');
        expect(info).toContain('  • [2] dogs (?) — free');
        expect(info).toContain('  • [3] untitled (?) — free');
        expect(info).toContain('  • [undefined] untitled (?) — free');
        expect(info.some((l) => l.includes('join <id> --yes'))).toBe(true);
    });
});

describe('join', () => {
    test('requires authentication', async () => {
        apiFactory.__mw.isAuthenticated.mockReturnValue(false);
        await joinChallengeCmd('1');
        expect(handlers['join-challenge']).not.toHaveBeenCalled();
    });

    test('exits with usage when no id is given', async () => {
        await expect(joinChallengeCmd(undefined)).rejects.toThrow('exit:1');
        expect(msgs('info')).toEqual(['Usage: join <id> [--yes]']);
    });

    test.each([
        [{ status: 'joined' }, 'info', '✅ Joined challenge 7.'],
        [{ status: 'skipped-unaffordable', cost: 10, coins: 3 }, 'error', 'needs 10, you have 3'],
        [{ status: 'skipped-unaffordable', cost: 10 }, 'error', 'you have ?'],
        [{ status: 'balance-unknown' }, 'error', 'Could not read your coin balance'],
        [{ status: 'charged-pending-submit' }, 'error', 'you will NOT be charged again'],
        [{ status: 'failed-no-charge' }, 'error', 'Could not join 7. No coins were charged.'],
        [{ status: 'skipped-no-photo' }, 'error', 'No eligible photo'],
        [{ status: 'unavailable' }, 'info', 'not open to join'],
        [{ status: 'busy' }, 'info', 'already in progress'],
        [{ status: 'not-authenticated' }, 'error', 'Not logged in'],
        [{ status: 'fetch-failed' }, 'error', 'Could not reach GuruShots'],
        [{ status: 'weird' }, 'error', 'Could not join 7 right now'],
        [undefined, 'error', 'Could not join 7 right now'],
    ])('free/first-attempt outcome %p is reported', async (result, level, text) => {
        handlers['join-challenge'].mockResolvedValue(invalid(result));
        await joinChallengeCmd('7');
        expect(handlers['join-challenge']).toHaveBeenCalledTimes(1);
        expect(handlers['join-challenge']).toHaveBeenCalledWith(null, '7', false);
        expect(msgs(level).some((m) => m.includes(text))).toBe(true);
    });

    test('an unknown status is logged at debug for diagnosis', async () => {
        handlers['join-challenge'].mockResolvedValue(invalid({ status: 'weird' }));
        await joinChallengeCmd('7');
        expect(msgs('debug')).toEqual(['join status=weird']);
    });

    test('a paid challenge without --yes prints the cost and spends nothing', async () => {
        handlers['join-challenge'].mockResolvedValue(invalid({ status: 'needs-confirm', cost: 25 }));
        await joinChallengeCmd('7');
        expect(handlers['join-challenge']).toHaveBeenCalledTimes(1);
        expect(msgs('info')).toEqual([
            'Challenge 7 is a PAID challenge — joining costs 25 coins.',
            'To spend the coins and join, re-run: join 7 --yes',
        ]);
    });

    test('a paid challenge with --yes spends and reports the confirmed join', async () => {
        handlers['join-challenge']
            .mockResolvedValueOnce(invalid({ status: 'needs-confirm', cost: 25 }))
            .mockResolvedValueOnce(invalid({ status: 'joined' }));
        await joinChallengeCmd('7', { yes: true });
        expect(handlers['join-challenge']).toHaveBeenLastCalledWith(null, '7', true);
        expect(msgs('info')).toContain('✅ Joined challenge 7.');
    });
});

describe('check-updates', () => {
    const realPlatform = process.platform;
    const realArch = process.arch;
    const setHost = (platform: string, arch: string) => {
        Object.defineProperty(process, 'platform', { value: platform, configurable: true });
        Object.defineProperty(process, 'arch', { value: arch, configurable: true });
    };
    afterEach(() => {
        setHost(realPlatform, realArch);
        mockHasBundledModel.mockImplementation(async () => true);
    });

    test('reports up to date', async () => {
        setHost('darwin', 'arm64');
        updateChecker.checkForUpdates.mockResolvedValue(invalid({ updateAvailable: false }));
        await checkUpdates();
        expect(updateChecker.checkForUpdates).toHaveBeenCalledWith({
            currentVersion: pkg.version,
            isBetaChannel: pkg.version.includes('-'),
            assetSuffix: '-mac',
        });
        expect(msgs('success')).toEqual([`You're up to date (${pkg.version}).`]);
    });

    test.each([
        ['darwin', 'arm64', true, '-mac'],
        ['linux', 'x64', true, '-linux'],
        ['linux', 'arm64', true, '-linux-arm'],
        ['darwin', 'arm64', false, '-mac-lite'],
        ['linux', 'x64', false, '-linux-lite'],
        ['linux', 'arm64', false, '-linux-arm-lite'],
        ['win32', 'x64', true, null],
    ])('%s/%s (model bundled: %p) links its own binary %p', async (platform, arch, bundled, suffix) => {
        setHost(platform, arch);
        mockHasBundledModel.mockImplementation(async () => bundled);
        updateChecker.checkForUpdates.mockResolvedValue(invalid({ updateAvailable: false }));
        await checkUpdates();
        expect(updateChecker.checkForUpdates).toHaveBeenLastCalledWith(
            expect.objectContaining({ assetSuffix: suffix }),
        );
    });

    test('a thrown check prints the sanitised message and the releases URL', async () => {
        updateChecker.checkForUpdates.mockRejectedValue(new Error('net\u001b[31m down'));
        await checkUpdates();
        expect(msgs('error')).toEqual(['Update check failed: net[31m down']);
        expect(msgs('info')).toContain('Check manually: https://releases');
    });

    test('a thrown non-Error value is stringified', async () => {
        updateChecker.checkForUpdates.mockRejectedValue('plain failure');
        await checkUpdates();
        expect(msgs('error')).toEqual(['Update check failed: plain failure']);
    });

    test('an error result is reported', async () => {
        updateChecker.checkForUpdates.mockResolvedValue(invalid({ error: 'rate limited' }));
        await checkUpdates();
        expect(msgs('error')).toEqual(['Update check failed: rate limited']);
        expect(msgs('info')).toContain('Check manually: https://releases');
    });

    test('an available prerelease prints version, date and download link', async () => {
        updateChecker.checkForUpdates.mockResolvedValue(
            invalid({
                updateAvailable: true,
                version: '9.0.0-beta.1',
                isPrerelease: true,
                releaseDate: '2026-09-01',
                downloadUrl: 'https://dl',
            }),
        );
        await checkUpdates();
        expect(msgs('success')).toEqual(['Update available: 9.0.0-beta.1 (prerelease)']);
        expect(msgs('info')).toEqual(expect.arrayContaining(['Released: 2026-09-01', 'Download: https://dl']));
        expect(all()).toContain('does not self-update');
    });

    test('a stable update without date/asset falls back to the releases URL', async () => {
        updateChecker.checkForUpdates.mockResolvedValue(invalid({ updateAvailable: true, version: undefined }));
        await checkUpdates();
        expect(msgs('success')).toEqual(['Update available: ']);
        expect(all()).not.toContain('Released:');
        expect(msgs('info')).toContain('Download: https://releases');
    });
});

describe('logs', () => {
    test.each([
        ['api', '/logs/api.log'],
        ['settings', '/logs/settings.log'],
        ['bogus', '/logs/app.log'],
    ])('category %p reads %p', (category, file) => {
        fs.existsSync.mockReturnValue(true);
        fs.readFileSync.mockReturnValue('a\nb');
        showLogs({ category, lines: 5 });
        expect(fs.readFileSync).toHaveBeenCalledWith(file, 'utf8');
    });

    test('defaults to the last 100 lines of the app log', () => {
        fs.existsSync.mockReturnValue(true);
        fs.readFileSync.mockReturnValue('x');
        showLogs();
        expect(msgs('info')[0]).toBe('=== app log (last 100 lines): /logs/app.log ===');
    });

    test('a missing path reports no file without touching the disk', () => {
        logger.getLogFile.mockReturnValueOnce(invalid(null));
        showLogs();
        expect(fs.existsSync).not.toHaveBeenCalled();
        expect(msgs('info')).toEqual(['No app log file found yet.']);
    });

    test('a read error is reported, not thrown', () => {
        fs.existsSync.mockReturnValue(true);
        fs.readFileSync.mockImplementation(() => {
            throw new Error('EACCES');
        });
        expect(() => showLogs({ category: 'error' })).not.toThrow();
        expect(msgs('error')).toEqual(['Error reading error log']);
        fs.readFileSync.mockReset();
    });
});
