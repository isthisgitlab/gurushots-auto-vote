/**
 * windows/quitGuard: holds a quit/close while auto-vote runs and a boost is
 * due within the horizon, asks, and re-issues it only on "Quit anyway".
 */

import type * as VotingLogicModule from '../../src/ts/services/VotingLogic';
import type * as quitGuardModule from '../../src/ts/windows/quitGuard';
import type { BrowserWindow, Dialog } from 'electron';
import type { Challenge } from '../../src/ts/types/gurushots';
import type { CategoryLogger } from '../../src/ts/logger';
import { invalid } from '../helpers/invalid';

type Deps = Parameters<typeof quitGuardModule.holdQuitForOpenBoosts>[1];
type ShowMessageBox = jest.MockedFunction<Dialog['showMessageBox']>;

jest.mock('../../src/ts/logger', () => {
    const cat = { info: jest.fn(), error: jest.fn() };
    return { withCategory: jest.fn(() => cat), cat };
});
jest.mock('../../src/ts/services/VotingLogic', () => ({ describeDeadlineActions: jest.fn(() => ({ actions: [] })) }));

const NOW = 1_000_000;
const timed = invalid<Challenge>({
    id: 1,
    title: 'Anything Music',
    member: { boost: { state: 'AVAILABLE', timeout: NOW + 1140 } },
});
const keyed = invalid<Challenge>({ id: 2, title: 'Metal & Wood', member: { boost: { state: 'AVAILABLE_KEY' } } });
const used = invalid<Challenge>({ id: 3, title: 'Banisters', member: { boost: { state: 'USED' } } });
const expired = invalid<Challenge>({
    id: 4,
    title: 'Best Meals',
    member: { boost: { state: 'AVAILABLE', timeout: NOW - 1 } },
});

// Boost due-at per challenge id, as describeDeadlineActions would report it.
const dueAt: Record<Challenge['id'], number> = { 1: NOW + 540, 2: NOW - 30, 3: NOW + 60, 4: NOW + 60 };
const describe_ = (c: Challenge) => ({
    actions: [
        { action: 'autoFill', dueAt: 0 },
        { action: 'boost', dueAt: dueAt[c.id] },
    ],
});

const t = (key: string) => `<${key}>`;
const flush = () => new Promise((r) => setImmediate(r));

let guard: typeof quitGuardModule;
let logger: {
    cat: { info: jest.MockedFunction<CategoryLogger['info']>; error: jest.MockedFunction<CategoryLogger['error']> };
};

beforeEach(() => {
    // Module-level state (list, bypass, prompting) must not leak across tests.
    jest.resetModules();
    guard = require('../../src/ts/windows/quitGuard') as typeof guard;
    logger = require('../../src/ts/logger') as typeof logger;
});

const setup = ({
    response = 1,
    parent = null,
    autovoteRunning = true,
    showMessageBox,
    describe = describe_,
}: {
    response?: number;
    parent?: Deps['parent'];
    autovoteRunning?: boolean;
    showMessageBox?: ShowMessageBox;
    describe?: Deps['describeDeadlineActions'];
} = {}) => {
    const event = { preventDefault: jest.fn() };
    const dialog: { showMessageBox: ShowMessageBox } = {
        showMessageBox: showMessageBox ?? invalid(jest.fn(() => Promise.resolve({ response }))),
    };
    const proceed = jest.fn();
    const hold = () =>
        guard.holdQuitForOpenBoosts(event, {
            autovoteRunning,
            dialog,
            parent,
            t,
            proceed,
            now: NOW,
            describeDeadlineActions: describe,
        });
    return { event, dialog, proceed, hold };
};

describe('holdQuitForOpenBoosts — when to ask', () => {
    test('passes through when nothing has been fetched yet', () => {
        const { event, dialog, hold } = setup();
        expect(hold()).toBe(false);
        expect(event.preventDefault).not.toHaveBeenCalled();
        expect(dialog.showMessageBox).not.toHaveBeenCalled();
    });

    test('passes through when auto-vote is stopped — quitting loses nothing', () => {
        guard.rememberChallenges([timed], false);
        const { event, hold } = setup({ autovoteRunning: false });
        expect(hold()).toBe(false);
        expect(event.preventDefault).not.toHaveBeenCalled();
    });

    test('ignores boosts whose window is closed or used, even if a boost row exists', () => {
        guard.rememberChallenges([used, expired], false);
        expect(setup().hold()).toBe(false);
    });

    test('ignores an open window whose boost is further off than the horizon', () => {
        // Key-unlocked boost on a challenge days from closing: no reason to ask.
        guard.rememberChallenges([keyed], false);
        const far = () => ({ actions: [{ action: 'boost', dueAt: NOW + 3 * 86400 }] });
        expect(setup({ describe: far }).hold()).toBe(false);

        const edge = () => ({ actions: [{ action: 'boost', dueAt: NOW + guard.QUIT_WARN_HORIZON_SEC }] });
        expect(setup({ describe: edge }).hold()).toBe(true);
    });

    test('ignores an open window auto-vote will not boost (no boost row / no due time)', () => {
        guard.rememberChallenges([timed], false);
        expect(setup({ describe: () => ({ actions: [] }) }).hold()).toBe(false);
        expect(setup({ describe: () => ({ actions: [{ action: 'boost', dueAt: null }] }) }).hold()).toBe(false);
        expect(setup({ describe: () => undefined }).hold()).toBe(false);
    });

    test('defaults to the real clock and VotingLogic.describeDeadlineActions', () => {
        const votingLogic = jest.mocked(require('../../src/ts/services/VotingLogic') as typeof VotingLogicModule);
        guard.rememberChallenges([keyed], false);
        votingLogic.describeDeadlineActions.mockReturnValue(
            invalid({
                actions: [{ action: 'boost', dueAt: Math.floor(Date.now() / 1000) + 60 }],
            }),
        );
        const dialog: { showMessageBox: ShowMessageBox } = {
            showMessageBox: invalid(jest.fn(() => new Promise(() => {}))),
        };
        const held = guard.holdQuitForOpenBoosts(
            { preventDefault: jest.fn() },
            { autovoteRunning: true, dialog, parent: null, t, proceed: jest.fn() },
        );
        expect(held).toBe(true);
        expect(votingLogic.describeDeadlineActions).toHaveBeenCalledWith(keyed, expect.any(Number));
    });

    test('a throw while reading boost state lets the quit through', () => {
        guard.rememberChallenges([timed], false);
        const err = new Error('bad challenge');
        const { event, hold } = setup({
            describe: () => {
                throw err;
            },
        });
        expect(hold()).toBe(false);
        expect(event.preventDefault).not.toHaveBeenCalled();
        expect(logger.cat.error).toHaveBeenCalledWith('Quit guard could not read boost state — not asking:', err);
    });

    test('ignores a non-array list and keeps the previous one', () => {
        guard.rememberChallenges([timed], false);
        guard.rememberChallenges(undefined, false);
        expect(setup().hold()).toBe(true);
    });
});

describe('holdQuitForOpenBoosts — the dialog', () => {
    test('holds, lists due boosts soonest first, and quits on "Quit anyway"', async () => {
        guard.rememberChallenges([timed, used, keyed], false);
        const { event, dialog, proceed, hold } = setup({ response: 1 });

        expect(hold()).toBe(true);
        expect(event.preventDefault).toHaveBeenCalled();
        const options = jest.mocked(dialog.showMessageBox as Dialog['showMessageBox']).mock.calls[0][0];
        expect(options).toMatchObject({
            type: 'warning',
            buttons: ['<quitGuard.keepRunning>', '<quitGuard.quitAnyway>'],
            defaultId: 0,
            cancelId: 0,
            message: '<quitGuard.title>',
        });
        expect(options.detail).toBe(
            '<quitGuard.detail>\n\n• Metal & Wood — <quitGuard.dueNow>\n• Anything Music — <quitGuard.dueIn>',
        );

        await flush();
        expect(proceed).toHaveBeenCalledTimes(1);
        expect(logger.cat.info).toHaveBeenCalledWith('Quit confirmed with 2 boost(s) due', null);

        // The re-issued quit passes straight through.
        expect(setup().hold()).toBe(false);
    });

    test('substitutes the time until the boost into the translated suffix', () => {
        guard.rememberChallenges([timed], false);
        const dialog: { showMessageBox: ShowMessageBox } = {
            showMessageBox: invalid(jest.fn(() => new Promise(() => {}))),
        };
        guard.holdQuitForOpenBoosts(
            { preventDefault: jest.fn() },
            {
                autovoteRunning: true,
                dialog,
                parent: null,
                t: (key) => (key === 'quitGuard.dueIn' ? 'boost due in {time}' : key),
                proceed: jest.fn(),
                now: NOW,
                describeDeadlineActions: describe_,
            },
        );
        expect(jest.mocked(dialog.showMessageBox as Dialog['showMessageBox']).mock.calls[0][0].detail).toContain(
            '• Anything Music — boost due in 9m',
        );
    });

    test('"Keep running" leaves the app up and asks again next time', async () => {
        guard.rememberChallenges([timed], false);
        const first = setup({ response: 0 });
        first.hold();
        await flush();
        expect(first.proceed).not.toHaveBeenCalled();

        const second = setup({ response: 0 });
        expect(second.hold()).toBe(true);
        expect(second.dialog.showMessageBox).toHaveBeenCalled();
    });

    test('a second quit while the dialog is up is held without stacking a dialog', () => {
        guard.rememberChallenges([timed], false);
        setup({ showMessageBox: invalid(jest.fn(() => new Promise(() => {}))) }).hold();

        const again = setup();
        expect(again.hold()).toBe(true);
        expect(again.event.preventDefault).toHaveBeenCalled();
        expect(again.dialog.showMessageBox).not.toHaveBeenCalled();
    });

    test('attaches the dialog to a live parent window, not a destroyed one', () => {
        guard.rememberChallenges([timed], false);
        const live = invalid<BrowserWindow>({ isDestroyed: () => false });
        const a = setup({ parent: live, showMessageBox: invalid(jest.fn(() => new Promise(() => {}))) });
        a.hold();
        expect(a.dialog.showMessageBox).toHaveBeenCalledWith(live, expect.any(Object));

        guard.resetQuitGuard();
        guard.rememberChallenges([timed], false);
        const dead = setup({
            parent: invalid({ isDestroyed: () => true }),
            showMessageBox: invalid(jest.fn(() => new Promise(() => {}))),
        });
        dead.hold();
        expect(dead.dialog.showMessageBox).toHaveBeenCalledWith(expect.objectContaining({ type: 'warning' }));
    });

    test('a failing dialog quits anyway instead of trapping the user', async () => {
        guard.rememberChallenges([timed], false);
        const err = new Error('no dialog');
        const { proceed, hold } = setup({ showMessageBox: invalid(jest.fn(() => Promise.reject(err))) });
        hold();
        await flush();
        expect(logger.cat.error).toHaveBeenCalledWith('Quit confirmation failed — quitting anyway:', err);
        expect(proceed).toHaveBeenCalledTimes(1);
    });
});

describe('bypass and reset', () => {
    afterEach(() => {
        jest.useRealTimers();
    });

    test('bypassQuitGuard waves quits through, then lapses so a quit that never landed is guarded again', () => {
        jest.useFakeTimers();
        guard.rememberChallenges([timed], false);
        guard.bypassQuitGuard();
        guard.bypassQuitGuard(); // re-arming replaces the pending timer
        expect(setup().hold()).toBe(false);

        jest.advanceTimersByTime(guard.BYPASS_TTL_MS);
        expect(setup().hold()).toBe(true);
    });

    test('resetQuitGuard clears bypass and the remembered list', () => {
        guard.rememberChallenges([timed], false);
        guard.bypassQuitGuard();
        guard.resetQuitGuard();
        expect(setup().hold()).toBe(false); // list cleared
        guard.rememberChallenges([timed], false);
        expect(setup().hold()).toBe(true); // bypass cleared
    });
});

describe('remembered list — suspend selection', () => {
    test('imminentBoostChallenges applies the given horizon, soonest first, and imminentBoosts selects the same set', () => {
        guard.rememberChallenges([timed, keyed, used, expired], false);
        const all = guard.imminentBoostChallenges(NOW, describe_, guard.QUIT_WARN_HORIZON_SEC);
        expect(all.map((b) => [b.challenge.id, b.dueAt])).toEqual([
            [2, NOW - 30],
            [1, NOW + 540],
        ]);
        const dialog: { showMessageBox: ShowMessageBox } = {
            showMessageBox: invalid(jest.fn(() => new Promise(() => {}))),
        };
        guard.holdQuitForOpenBoosts(
            { preventDefault: jest.fn() },
            {
                autovoteRunning: true,
                dialog,
                parent: null,
                t,
                proceed: jest.fn(),
                now: NOW,
                describeDeadlineActions: describe_,
            },
        );
        const { detail } = jest.mocked(dialog.showMessageBox as Dialog['showMessageBox']).mock.calls[0][0];
        expect(all.map((b) => `• ${b.challenge.title} —`).every((line) => detail?.includes(line))).toBe(true);
    });

    test('the suspend horizon is 30 min: due at exactly 30 min is selected, 31 min is not', () => {
        guard.rememberChallenges([keyed], false);
        const at = (sec: number) => () => ({ actions: [{ action: 'boost', dueAt: NOW + sec }] });
        expect(guard.SUSPEND_BOOST_HORIZON_SEC).toBe(30 * 60);
        expect(guard.imminentBoostChallenges(NOW, at(1800), guard.SUSPEND_BOOST_HORIZON_SEC)).toHaveLength(1);
        expect(guard.imminentBoostChallenges(NOW, at(1860), guard.SUSPEND_BOOST_HORIZON_SEC)).toHaveLength(0);
    });

    test('rememberChallenges records the mock flag it was fetched under; a non-array leaves both untouched', () => {
        expect(guard.rememberedChallengesMock()).toBeNull();
        guard.rememberChallenges([timed], true);
        expect(guard.rememberedChallengesMock()).toBe(true);
        guard.rememberChallenges(undefined, false);
        expect(guard.rememberedChallengesMock()).toBe(true);
        guard.resetQuitGuard();
        expect(guard.rememberedChallengesMock()).toBeNull();
    });

    test('markBoostApplied marks the boost used, so the quit guard no longer prompts for it', () => {
        const fresh = invalid<Challenge>({
            id: 1,
            title: 'Anything Music',
            member: { boost: { state: 'AVAILABLE', timeout: NOW + 1140 } },
        });
        guard.rememberChallenges([fresh], false);
        expect(setup().hold()).toBe(true);
        guard.markBoostApplied(1);
        expect(fresh.member?.boost?.state).toBe('USED');
        expect(setup().hold()).toBe(false);
    });

    test('markBoostApplied ignores an unknown id and a challenge without a boost', () => {
        const bare = invalid<Challenge>({ id: 9, title: 'Bare' });
        guard.rememberChallenges([bare, timed], false);
        expect(() => guard.markBoostApplied(9)).not.toThrow();
        expect(() => guard.markBoostApplied(404)).not.toThrow();
        expect(timed.member?.boost?.state).toBe('AVAILABLE');
    });
});
