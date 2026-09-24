/**
 * windows/quitGuard: holds a quit/close while auto-vote runs and a boost is
 * due within the horizon, asks, and re-issues it only on "Quit anyway".
 */

jest.mock('../../src/js/logger', () => {
    const cat = { info: jest.fn(), error: jest.fn() };
    return { withCategory: jest.fn(() => cat), cat };
});
jest.mock('../../src/js/services/VotingLogic', () => ({ describeDeadlineActions: jest.fn(() => ({ actions: [] })) }));

const NOW = 1_000_000;
const timed = { id: 1, title: 'Anything Music', member: { boost: { state: 'AVAILABLE', timeout: NOW + 1140 } } };
const keyed = { id: 2, title: 'Metal & Wood', member: { boost: { state: 'AVAILABLE_KEY' } } };
const used = { id: 3, title: 'Banisters', member: { boost: { state: 'USED' } } };
const expired = { id: 4, title: 'Best Meals', member: { boost: { state: 'AVAILABLE', timeout: NOW - 1 } } };

// Boost due-at per challenge id, as describeDeadlineActions would report it.
const dueAt = { 1: NOW + 540, 2: NOW - 30, 3: NOW + 60, 4: NOW + 60 };
const describe_ = (c) => ({
    actions: [
        { action: 'autoFill', dueAt: 0 },
        { action: 'boost', dueAt: dueAt[c.id] },
    ],
});

const t = (key) => `<${key}>`;
const flush = () => new Promise((r) => setImmediate(r));

let guard;
let logger;

beforeEach(() => {
    // Module-level state (list, bypass, prompting) must not leak across tests.
    jest.resetModules();
    guard = require('../../src/js/windows/quitGuard');
    logger = require('../../src/js/logger');
});

const setup = ({ response = 1, parent = null, autovoteRunning = true, showMessageBox, describe = describe_ } = {}) => {
    const event = { preventDefault: jest.fn() };
    const dialog = { showMessageBox: showMessageBox ?? jest.fn(() => Promise.resolve({ response })) };
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
        guard.rememberChallenges([timed]);
        const { event, hold } = setup({ autovoteRunning: false });
        expect(hold()).toBe(false);
        expect(event.preventDefault).not.toHaveBeenCalled();
    });

    test('ignores boosts whose window is closed or used, even if a boost row exists', () => {
        guard.rememberChallenges([used, expired]);
        expect(setup().hold()).toBe(false);
    });

    test('ignores an open window whose boost is further off than the horizon', () => {
        // Key-unlocked boost on a challenge days from closing: no reason to ask.
        guard.rememberChallenges([keyed]);
        const far = () => ({ actions: [{ action: 'boost', dueAt: NOW + 3 * 86400 }] });
        expect(setup({ describe: far }).hold()).toBe(false);

        const edge = () => ({ actions: [{ action: 'boost', dueAt: NOW + guard.QUIT_WARN_HORIZON_SEC }] });
        expect(setup({ describe: edge }).hold()).toBe(true);
    });

    test('ignores an open window auto-vote will not boost (no boost row / no due time)', () => {
        guard.rememberChallenges([timed]);
        expect(setup({ describe: () => ({ actions: [] }) }).hold()).toBe(false);
        expect(setup({ describe: () => ({ actions: [{ action: 'boost', dueAt: null }] }) }).hold()).toBe(false);
        expect(setup({ describe: () => undefined }).hold()).toBe(false);
    });

    test('defaults to the real clock and VotingLogic.describeDeadlineActions', () => {
        const votingLogic = require('../../src/js/services/VotingLogic');
        guard.rememberChallenges([keyed]);
        votingLogic.describeDeadlineActions.mockReturnValue({
            actions: [{ action: 'boost', dueAt: Math.floor(Date.now() / 1000) + 60 }],
        });
        const dialog = { showMessageBox: jest.fn(() => new Promise(() => {})) };
        const held = guard.holdQuitForOpenBoosts(
            { preventDefault: jest.fn() },
            { autovoteRunning: true, dialog, parent: null, t, proceed: jest.fn() },
        );
        expect(held).toBe(true);
        expect(votingLogic.describeDeadlineActions).toHaveBeenCalledWith(keyed, expect.any(Number));
    });

    test('a throw while reading boost state lets the quit through', () => {
        guard.rememberChallenges([timed]);
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
        guard.rememberChallenges([timed]);
        guard.rememberChallenges(undefined);
        expect(setup().hold()).toBe(true);
    });
});

describe('holdQuitForOpenBoosts — the dialog', () => {
    test('holds, lists due boosts soonest first, and quits on "Quit anyway"', async () => {
        guard.rememberChallenges([timed, used, keyed]);
        const { event, dialog, proceed, hold } = setup({ response: 1 });

        expect(hold()).toBe(true);
        expect(event.preventDefault).toHaveBeenCalled();
        const options = dialog.showMessageBox.mock.calls[0][0];
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
        guard.rememberChallenges([timed]);
        const dialog = { showMessageBox: jest.fn(() => new Promise(() => {})) };
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
        expect(dialog.showMessageBox.mock.calls[0][0].detail).toContain('• Anything Music — boost due in 9m');
    });

    test('"Keep running" leaves the app up and asks again next time', async () => {
        guard.rememberChallenges([timed]);
        const first = setup({ response: 0 });
        first.hold();
        await flush();
        expect(first.proceed).not.toHaveBeenCalled();

        const second = setup({ response: 0 });
        expect(second.hold()).toBe(true);
        expect(second.dialog.showMessageBox).toHaveBeenCalled();
    });

    test('a second quit while the dialog is up is held without stacking a dialog', () => {
        guard.rememberChallenges([timed]);
        setup({ showMessageBox: jest.fn(() => new Promise(() => {})) }).hold();

        const again = setup();
        expect(again.hold()).toBe(true);
        expect(again.event.preventDefault).toHaveBeenCalled();
        expect(again.dialog.showMessageBox).not.toHaveBeenCalled();
    });

    test('attaches the dialog to a live parent window, not a destroyed one', () => {
        guard.rememberChallenges([timed]);
        const live = { isDestroyed: () => false };
        const a = setup({ parent: live, showMessageBox: jest.fn(() => new Promise(() => {})) });
        a.hold();
        expect(a.dialog.showMessageBox).toHaveBeenCalledWith(live, expect.any(Object));

        guard.resetQuitGuard();
        guard.rememberChallenges([timed]);
        const dead = setup({
            parent: { isDestroyed: () => true },
            showMessageBox: jest.fn(() => new Promise(() => {})),
        });
        dead.hold();
        expect(dead.dialog.showMessageBox).toHaveBeenCalledWith(expect.objectContaining({ type: 'warning' }));
    });

    test('a failing dialog quits anyway instead of trapping the user', async () => {
        guard.rememberChallenges([timed]);
        const err = new Error('no dialog');
        const { proceed, hold } = setup({ showMessageBox: jest.fn(() => Promise.reject(err)) });
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
        guard.rememberChallenges([timed]);
        guard.bypassQuitGuard();
        guard.bypassQuitGuard(); // re-arming replaces the pending timer
        expect(setup().hold()).toBe(false);

        jest.advanceTimersByTime(guard.BYPASS_TTL_MS);
        expect(setup().hold()).toBe(true);
    });

    test('resetQuitGuard clears bypass and the remembered list', () => {
        guard.rememberChallenges([timed]);
        guard.bypassQuitGuard();
        guard.resetQuitGuard();
        expect(setup().hold()).toBe(false); // list cleared
        guard.rememberChallenges([timed]);
        expect(setup().hold()).toBe(true); // bypass cleared
    });
});
