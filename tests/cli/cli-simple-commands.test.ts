/**
 * Unit tests for the thin CLI command modules: auth (login / logout),
 * bankroll, join (discover / join), update (check-updates) and logs. Each
 * module is a shell over a shared service or IPC handler, so those are
 * mocked and the tests assert what gets printed and dispatched.
 */

jest.mock('../../src/ts/logger', () => {
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

jest.mock('../../src/ts/settings', () => ({
    loadSettings: jest.fn(() => ({ mock: false })),
    setSetting: jest.fn(),
}));

jest.mock('../../src/ts/apiFactory', () => {
    const middleware = { isAuthenticated: jest.fn(() => true), cliLogin: jest.fn() };
    return { __mw: middleware, getMiddleware: jest.fn(() => middleware), refreshApi: jest.fn() };
});

jest.mock('../../src/ts/services/auth', () => ({ clearAuthToken: jest.fn() }));

jest.mock('../../src/ts/cli/prompts', () => ({
    createReadlineInterface: jest.fn(),
    askYesNo: jest.fn(),
    askInput: jest.fn(),
    askSecret: jest.fn(),
}));

jest.mock('../../src/ts/ipc/actions.handlers', () => {
    const handlers = {
        'get-bankroll': jest.fn(),
        'get-member-challenges': jest.fn(),
        'join-challenge': jest.fn(),
        'forget-unconfirmed-payment': jest.fn(),
    };
    return { __handlers: handlers, buildHandlers: jest.fn(() => handlers) };
});

jest.mock('../../src/ts/services/UpdateChecker', () => ({
    checkForUpdates: jest.fn(),
    getReleasesUrl: jest.fn(() => 'https://releases'),
}));

const mockHasBundledModel = jest.fn(async () => true);
jest.mock('../../src/ts/services/visionVerifier', () => ({ hasBundledModel: mockHasBundledModel }));

import { invalid } from '../helpers/invalid';
import fsModule = require('node:fs');
const fs = jest.mocked(fsModule);
import loggerModule = require('../../src/ts/logger');
const logger = jest.mocked(
    invalid<typeof loggerModule & { __calls: { level: string; msg: unknown; data?: unknown }[] }>(loggerModule),
);
import settingsModule = require('../../src/ts/settings');
const settings = jest.mocked(settingsModule);
import apiFactoryModule = require('../../src/ts/apiFactory');
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
const { clearAuthToken } = jest.mocked(require('../../src/ts/services/auth') as typeof authModule);
import promptsModule = require('../../src/ts/cli/prompts');
const prompts = jest.mocked(promptsModule);
// The handler-module mocks expose their jest.fn table for the assertions.
type HandlersMock = {
    __handlers: jest.Mocked<
        Pick<
            ReturnType<typeof actionsHandlersModule.buildHandlers>,
            'get-bankroll' | 'get-member-challenges' | 'join-challenge' | 'forget-unconfirmed-payment'
        >
    >;
};
const handlers = invalid<HandlersMock>(require('../../src/ts/ipc/actions.handlers')).__handlers;
import updateCheckerModule = require('../../src/ts/services/UpdateChecker');
const updateChecker = jest.mocked(updateCheckerModule);
import type * as authModule from '../../src/ts/services/auth';
import type * as actionsHandlersModule from '../../src/ts/ipc/actions.handlers';
import type * as authCommandsModule from '../../src/ts/cli/commands/auth';
import type * as bankrollModule from '../../src/ts/cli/commands/bankroll';
import type * as joinModule from '../../src/ts/cli/commands/join';
import type * as updateModule from '../../src/ts/cli/commands/update';
import type * as logsModule from '../../src/ts/cli/commands/logs';
const pkg = jest.requireActual<typeof import('../../package.json')>('../../package.json');

const { handleLogin, handleLogout } = require('../../src/ts/cli/commands/auth') as typeof authCommandsModule;
const { showBankroll } = require('../../src/ts/cli/commands/bankroll') as typeof bankrollModule;
const { showDiscover, joinChallengeCmd, forgetPaymentCmd } =
    require('../../src/ts/cli/commands/join') as typeof joinModule;
const { checkUpdates } = require('../../src/ts/cli/commands/update') as typeof updateModule;
const { showLogs } = require('../../src/ts/cli/commands/logs') as typeof logsModule;

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
        expect(handlers['get-member-challenges']).toHaveBeenCalledWith(null);
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
        expect(info).toContain('=== Open and upcoming challenges ===');
        // No upcoming row, no upcoming advice.
        expect(info.some((l) => l.includes('list-photos'))).toBe(false);
    });

    test('prints the cost as a number, whatever the server sent', async () => {
        const esc = String.fromCharCode(27);
        handlers['get-member-challenges'].mockResolvedValue(
            invalid({
                success: true,
                items: [
                    { id: 1, title: 'A', join_coins: `5\r${esc}[2Jgone` },
                    { id: 2, title: 'B', join_coins: '12' },
                    { id: 3, title: 'C', join_coins: 40 },
                ],
            }),
        );
        await showDiscover();
        const info = msgs('info');
        // A value that is no number is not printed at all; one that is, is printed as the number.
        expect(info).toContain('  • [1] A (?) — free');
        expect(info).toContain('  • [2] B (?) — 12 coins');
        expect(info).toContain('  • [3] C (?) — 40 coins');
        expect(all()).not.toContain(String.fromCharCode(27));
        expect(all()).not.toContain('\r');
    });

    describe('upcoming challenges', () => {
        const NOW_SEC = 1_800_000_000;
        beforeEach(() => {
            jest.spyOn(Date, 'now').mockReturnValue(NOW_SEC * 1000);
        });
        afterEach(() => jest.mocked(Date.now).mockRestore());

        test('are marked "starts in …", and followed by the steps to choose their photos', async () => {
            handlers['get-member-challenges'].mockResolvedValue(
                invalid({
                    success: true,
                    items: [
                        { id: 1, title: 'Open One', type: 'default', join_coins: 0 },
                        {
                            id: 2,
                            title: 'Soon',
                            type: 'flash',
                            join_coins: 100,
                            status: 'upcoming',
                            start_time: NOW_SEC + 2 * 3600 + 15 * 60,
                        },
                    ],
                }),
            );
            await showDiscover();
            const info = msgs('info');
            expect(info).toContain('  • [1] Open One (default) — free');
            expect(info).toContain('  • [2] Soon (flash) — 100 coins — starts in 2h 15m');
            expect(info).toContain('  list-photos --challenge=<id>');
            expect(info).toContain(`  set-setting chosenPhotos '["<photo id>"]' --challenge=<id>`);
            expect(info.some((l) => l.includes('cannot be joined until they start'))).toBe(true);
        });

        test("print the server's text without terminal control sequences", async () => {
            const esc = String.fromCharCode(27);
            handlers['get-member-challenges'].mockResolvedValue(
                invalid({
                    success: true,
                    items: [
                        {
                            id: `7${esc}[2J`,
                            title: `Evil${esc}]0;owned${String.fromCharCode(7)} title`,
                            type: `fl${esc}[31mash`,
                            status: 'upcoming',
                            start_time: NOW_SEC + 600,
                        },
                        { id: 8, url: `dogs${esc}[1A`, status: 'upcoming', start_time: NOW_SEC + 600 },
                    ],
                }),
            );
            await showDiscover();
            const printed = all();
            expect(printed).not.toContain(esc);
            expect(printed).not.toContain(String.fromCharCode(7));
            expect(printed).toContain('Evil');
            expect(printed).toContain('dogs');
        });
    });
});

describe('join', () => {
    test('requires authentication', async () => {
        apiFactory.__mw.isAuthenticated.mockReturnValue(false);
        expect(await joinChallengeCmd('1')).toBe(1);
        expect(handlers['join-challenge']).not.toHaveBeenCalled();
    });

    test('exits with usage when no id is given', async () => {
        await expect(joinChallengeCmd(undefined)).rejects.toThrow('exit:1');
        expect(msgs('info')).toEqual(['Usage: join <id> [--yes [--max-coins=<coins>]]']);
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
        [{ status: 'not-started' }, 'info', "has not started yet, so it can't be joined"],
        [{ status: 'not-started' }, 'info', 'set-setting chosenPhotos \'["<photo id>"]\' --challenge=7'],
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

    test('coins spent but no photo qualifies: the line says what is missing, not just to re-run', async () => {
        handlers['join-challenge'].mockResolvedValue(
            invalid({ status: 'charged-pending-submit', reason: 'no-photo', cost: 100 }),
        );
        await joinChallengeCmd('7');
        expect(msgs('error')).toEqual([
            'Coins were already spent on 7, but no photo qualifies for this challenge. Add an eligible photo, then re-run "join 7 --yes" — you will NOT be charged again. If you use Must Include Tags, or have turned off Submit Even Without a Tag Match, those can also be what blocks the pick.',
        ]);
    });

    const RERUN = 'Re-run "join 7": it only submits your photo, so you are never charged twice.';
    const FORGET = 'If the GuruShots website shows the coins were not taken, run "forget-payment 7" and join again.';
    const CHECK =
        'Other coin activity since then changes the difference, and this app does not decide whether the payment went through: the coin history on the GuruShots website is what counts.';

    test('a payment that got no answer says so, that a retry only submits, and how to forget it', async () => {
        handlers['join-challenge'].mockResolvedValue(
            invalid({ status: 'charged-pending-submit', reason: 'unconfirmed', cost: 100 }),
        );
        await joinChallengeCmd('7');
        expect(msgs('error')).toEqual([
            `The payment for 7 got no answer, so it may or may not have gone through, and the join did not finish. ${RERUN} ${FORGET}`,
        ]);
        expect(handlers['get-bankroll']).not.toHaveBeenCalled();
    });

    test('with the balance recorded before the payment, it is set beside the one GuruShots reports now', async () => {
        handlers['join-challenge'].mockResolvedValue(
            invalid({ status: 'charged-pending-submit', reason: 'unconfirmed', cost: 100, coinsBefore: 500 }),
        );
        handlers['get-bankroll'].mockResolvedValue(invalid({ success: true, coins: 400 }));
        await joinChallengeCmd('7');
        expect(msgs('error')).toEqual([
            `The payment for 7 got no answer, so it may or may not have gone through, and the join did not finish. Coins before this payment: 500; GuruShots reports 400 now. ${CHECK} ${RERUN} ${FORGET}`,
        ]);
    });

    test.each([
        ['could not be read', { success: false }, 'Coins before this payment: 500. '],
        ['is not a number', { success: true, coins: 'many' }, 'Coins before this payment: 500. '],
    ])('a balance now that %s leaves the one from before alone', async (_name, bankroll, text) => {
        handlers['join-challenge'].mockResolvedValue(
            invalid({ status: 'charged-pending-submit', reason: 'unconfirmed', coinsBefore: 500 }),
        );
        handlers['get-bankroll'].mockResolvedValue(invalid(bankroll));
        await joinChallengeCmd('7');
        expect(msgs('error')[0]).toContain(`${text}${CHECK}`);
        expect(msgs('error')[0]).not.toContain('reports');
    });

    test("an earlier payment record is worded as an older version's, possibly another account's, and shows no balances", async () => {
        handlers['join-challenge'].mockResolvedValue(
            invalid({ status: 'charged-pending-submit', reason: 'earlier-payment', cost: 100, coinsBefore: 500 }),
        );
        await joinChallengeCmd('7');
        expect(msgs('error')).toEqual([
            `Challenge 7 has a payment record from an older version of the app, from before accounts were told apart, so it is not known whether the coins were taken, or by which GuruShots account used on this device. The join did not finish. ${RERUN} The record cannot be forgotten here, because it may belong to another account: it stops applying to other accounts once the account that paid joins the challenge through this app, and otherwise clears by itself, at the next check after 30 days. If this is not the account that paid, you can join the challenge on the GuruShots website meanwhile.`,
        ]);
        expect(msgs('error')[0]).not.toContain('forget-payment');
        expect(handlers['get-bankroll']).not.toHaveBeenCalled();
    });

    test('an account that could not be identified says so, instead of "no coins were charged"', async () => {
        handlers['join-challenge'].mockResolvedValue(
            invalid({ status: 'failed-no-charge', reason: 'account-unknown', cost: 100 }),
        );
        await joinChallengeCmd('7');
        expect(msgs('error')).toEqual([
            'Could not confirm which account is logged in, so this attempt to join 7 spent no coins. Try again shortly, or run "login" again.',
        ]);
    });

    test('a challenge this account has already joined says so and spent nothing, and is not a success of this call', async () => {
        handlers['join-challenge'].mockResolvedValue(
            invalid({ status: 'failed-no-charge', reason: 'already-joined', cost: 100 }),
        );
        expect(await joinChallengeCmd('7')).toBe(1);
        expect(msgs('info')).toEqual(['This account has already joined 7; nothing was spent.']);
        expect(msgs('error')).toEqual([]);
    });

    test('an invalid-args refusal prints the invalid-id text, not the retry fallback', async () => {
        handlers['join-challenge'].mockResolvedValue(invalid({ success: false, error: 'invalid-args' }));
        await joinChallengeCmd('7');
        expect(msgs('error')).toEqual(['Invalid challenge or image id.']);
        expect(msgs('debug')).toEqual([]);
    });

    test('an unknown status is logged at debug for diagnosis', async () => {
        handlers['join-challenge'].mockResolvedValue(invalid({ status: 'weird' }));
        await joinChallengeCmd('7');
        expect(msgs('debug')).toEqual(['join status=weird']);
    });

    // Only a challenge that was joined exits 0: anything else did not join it.
    test.each([
        ['joined', 0],
        ['failed-no-charge', 1],
        ['charged-pending-submit', 1],
        ['skipped-unaffordable', 1],
        ['balance-unknown', 1],
        ['skipped-no-photo', 1],
        ['unavailable', 1],
        ['not-started', 1],
        ['busy', 1],
        ['not-authenticated', 1],
        ['fetch-failed', 1],
        ['weird', 1],
    ])('a join answering %s exits %i', async (status, code) => {
        handlers['join-challenge'].mockResolvedValue(invalid({ status }));
        expect(await joinChallengeCmd('7')).toBe(code);
    });

    test('a paid challenge priced without --yes exits 1 (nothing was joined); confirmed and joined it exits 0', async () => {
        handlers['join-challenge'].mockResolvedValue(invalid({ status: 'needs-confirm', cost: 25 }));
        expect(await joinChallengeCmd('7')).toBe(1);
        handlers['join-challenge']
            .mockResolvedValueOnce(invalid({ status: 'needs-confirm', cost: 25 }))
            .mockResolvedValueOnce(invalid({ status: 'joined' }));
        expect(await joinChallengeCmd('7', { yes: true })).toBe(0);
        handlers['join-challenge']
            .mockResolvedValueOnce(invalid({ status: 'needs-confirm', cost: 25 }))
            .mockResolvedValueOnce(invalid({ status: 'failed-no-charge' }));
        expect(await joinChallengeCmd('7', { yes: true })).toBe(1);
    });

    test('a paid challenge without --yes prints the cost and spends nothing', async () => {
        handlers['join-challenge'].mockResolvedValue(invalid({ status: 'needs-confirm', cost: 25 }));
        await joinChallengeCmd('7');
        expect(handlers['join-challenge']).toHaveBeenCalledTimes(1);
        expect(msgs('info')).toEqual([
            'Challenge 7 is a PAID challenge — joining costs 25 coins.',
            'To spend the coins and join, re-run: join 7 --yes --max-coins=25',
        ]);
    });

    test('the cost it prints is a number, whatever the handler sent', async () => {
        handlers['join-challenge'].mockResolvedValue(invalid({ status: 'needs-confirm', cost: '25\r\u001b[2Jfree' }));
        await joinChallengeCmd('7');
        expect(msgs('info').join('\n')).not.toContain(String.fromCharCode(27));
        expect(msgs('info').join('\n')).not.toContain('\r');
        expect(msgs('info')[0]).toBe('Challenge 7 is a PAID challenge — joining costs NaN coins.');
    });

    test('a paid challenge with --yes spends and reports the confirmed join', async () => {
        handlers['join-challenge']
            .mockResolvedValueOnce(invalid({ status: 'needs-confirm', cost: 25 }))
            .mockResolvedValueOnce(invalid({ status: 'joined' }));
        await joinChallengeCmd('7', { yes: true });
        // --yes alone accepts the cost at that moment: no cost is named.
        expect(handlers['join-challenge']).toHaveBeenLastCalledWith(null, '7', true);
        expect(msgs('info')).toContain('✅ Joined challenge 7.');
    });

    test('--max-coins is the most the confirmed join may cost', async () => {
        handlers['join-challenge']
            .mockResolvedValueOnce(invalid({ status: 'needs-confirm', cost: 25 }))
            .mockResolvedValueOnce(invalid({ status: 'joined' }));
        await joinChallengeCmd('7', { yes: true, maxCoins: 25 });
        expect(handlers['join-challenge']).toHaveBeenLastCalledWith(null, '7', true, 25);
        expect(msgs('info')).toContain('✅ Joined challenge 7.');
    });

    test('a price that rose past --max-coins is refused with the new cost, and nothing is spent', async () => {
        handlers['join-challenge']
            .mockResolvedValueOnce(invalid({ status: 'needs-confirm', cost: 25 }))
            .mockResolvedValueOnce(invalid({ success: false, status: 'needs-confirm', cost: 40 }));
        await joinChallengeCmd('7', { yes: true, maxCoins: 25 });
        expect(msgs('error')).toEqual([
            'Challenge 7 costs 40 coins, more than --max-coins allows. Nothing was spent — to pay this cost, re-run: join 7 --yes --max-coins=40',
        ]);
        expect(msgs('info')).not.toContain('✅ Joined challenge 7.');
    });
});

describe('forget-payment', () => {
    test('requires authentication', async () => {
        apiFactory.__mw.isAuthenticated.mockReturnValue(false);
        expect(await forgetPaymentCmd('1')).toBe(1);
        expect(handlers['forget-unconfirmed-payment']).not.toHaveBeenCalled();
    });

    test('exits with usage when no id is given', async () => {
        await expect(forgetPaymentCmd(undefined)).rejects.toThrow('exit:1');
        expect(msgs('info')).toEqual(['Usage: forget-payment <id>']);
        expect(handlers['forget-unconfirmed-payment']).not.toHaveBeenCalled();
    });

    test.each([
        [
            'forgotten',
            'info',
            'Forgot the unconfirmed payment for 7. If the coins were in fact taken, joining it again charges you a second time, and auto-join may join it again within its coin budget. Run "join 7"',
        ],
        [
            'legacy-record',
            'error',
            'is from an older version of the app and may belong to another GuruShots account used on this device, so it cannot be forgotten here. It stops applying to other accounts once the account that paid joins the challenge through this app, and otherwise clears by itself, at the next check after 30 days.',
        ],
        ['nothing-to-forget', 'error', 'Nothing to forget for 7'],
        [
            'busy',
            'error',
            'A join of 7 is in progress, or another process is using the saved payment records. Nothing was changed.',
        ],
        ['account-unknown', 'error', 'Could not confirm which account is logged in, so nothing was changed'],
        ['not-authenticated', 'error', 'Not logged in'],
        [
            'unreadable',
            'error',
            'Restart the app and try again; if it keeps happening, the join-state file needs attention — check the log',
        ],
    ] as const)('answer %s is reported', async (status, level, text) => {
        handlers['forget-unconfirmed-payment'].mockResolvedValue(
            status === 'forgotten' ? { success: true, status } : { success: false, error: status, status },
        );
        // Only a payment that was forgotten is a success; every other answer exits 1.
        expect(await forgetPaymentCmd('7')).toBe(status === 'forgotten' ? 0 : 1);
        expect(handlers['forget-unconfirmed-payment']).toHaveBeenCalledWith(null, '7');
        expect(msgs(level).some((m) => m.includes(text))).toBe(true);
    });

    test.each([
        [{ success: false, error: 'invalid-args' }],
        [{ success: false, error: 'No authentication token found' }],
        [{ success: false, error: 'x', status: 'weird' }],
    ])('an answer the command has no line for (%p) is a failure', async (answer) => {
        handlers['forget-unconfirmed-payment'].mockResolvedValue(invalid(answer));
        expect(await forgetPaymentCmd('7')).toBe(1);
        expect(msgs('error')).toEqual(['Could not forget the payment for 7 right now. Please try again.']);
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
