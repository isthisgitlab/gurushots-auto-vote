/**
 * Unit tests for the CLI currency commands (unlock-boost / swap /
 * fill-exposure). They mirror `join <id> [--yes]`: without --yes nothing is
 * spent — the cost and the re-run line are printed — and swap --yes must name
 * the previewed replacement with --to. The IPC handlers are mocked; the tests
 * assert the dispatch and the confirmation gate.
 */

jest.mock('../../src/js/logger.js', () => {
    const calls = [];
    const rec = (level) => (msg, data) => calls.push({ level, msg, data });
    const cat = {
        info: rec('info'),
        error: rec('error'),
        success: rec('success'),
        warning: rec('warning'),
        debug: rec('debug'),
    };
    return { __calls: calls, withCategory: jest.fn(() => cat), CATEGORIES: {} };
});

jest.mock('../../src/js/settings.js', () => ({
    getSetting: jest.fn(() => 'tok'),
    loadSettings: jest.fn(() => ({ mock: true, token: 'tok' })),
}));

jest.mock('../../src/js/apiFactory', () => {
    const getActiveChallenges = jest.fn();
    const isAuthenticated = jest.fn(() => true);
    return {
        __getActiveChallenges: getActiveChallenges,
        __isAuthenticated: isAuthenticated,
        getMiddleware: jest.fn(() => ({ isAuthenticated, getActiveChallenges })),
        getApiStrategy: jest.fn(),
    };
});

jest.mock('../../src/js/ipc/actions.handlers', () => {
    const handlers = { 'get-bankroll': jest.fn() };
    return { __handlers: handlers, buildHandlers: () => handlers, register: jest.fn() };
});

jest.mock('../../src/js/ipc/currency.handlers', () => {
    const handlers = {
        'key-unlock-boost': jest.fn(),
        'preview-swap-photo': jest.fn(),
        'swap-entry-photo': jest.fn(),
        'get-swap-backs': jest.fn(),
        'swap-back-entry-photo': jest.fn(),
        'fill-exposure': jest.fn(),
    };
    return { __handlers: handlers, buildHandlers: () => handlers, register: jest.fn() };
});

const logger = require('../../src/js/logger.js');
const apiFactory = require('../../src/js/apiFactory');
const handlers = {
    ...require('../../src/js/ipc/actions.handlers').__handlers,
    ...require('../../src/js/ipc/currency.handlers').__handlers,
};
const { unlockBoostCmd, swapCmd, swapBackCmd, fillExposureCmd } = require('../../src/js/cli/commands/actions');

const msgsAt = (level) => logger.__calls.filter((c) => c.level === level).map((c) => String(c.msg));
const contains = (arr, sub) => arr.some((s) => s.includes(sub));

beforeEach(() => {
    logger.__calls.length = 0;
    jest.clearAllMocks();
    apiFactory.__isAuthenticated.mockReturnValue(true);
    apiFactory.__getActiveChallenges.mockResolvedValue({ challenges: [{ id: 111, title: 'Sunset' }] });
    handlers['get-bankroll'].mockResolvedValue({ success: true, keys: 4, swaps: 7, fills: 2, coins: 0 });
    handlers['preview-swap-photo'].mockResolvedValue({ success: true, candidate: { id: 'new9', member_id: 'm' } });
});

describe.each([
    ['unlock-boost', unlockBoostCmd, 'key-unlock-boost', 'balance 4 → 3'],
    ['fill-exposure', fillExposureCmd, 'fill-exposure', 'balance 2 → 1'],
])('%s', (name, cmd, channel, balanceLine) => {
    test('without --yes: prints the cost and the re-run line, spends nothing', async () => {
        await cmd('111', {});
        expect(handlers[channel]).not.toHaveBeenCalled();
        expect(contains(msgsAt('info'), balanceLine)).toBe(true);
        expect(contains(msgsAt('info'), `${name} --challenge=111 --yes`)).toBe(true);
    });

    test('with --yes: spends with confirmed=true and reports success', async () => {
        handlers[channel].mockResolvedValue({ success: true, outcome: 'ok' });
        await cmd('111', { yes: true });
        expect(handlers[channel]).toHaveBeenCalledWith(null, '111', true);
        expect(msgsAt('success')).toHaveLength(1);
    });

    test('a failed spend prints the outcome in plain words', async () => {
        handlers[channel].mockResolvedValue({ success: false, outcome: 'no-balance' });
        await cmd('111', { yes: true });
        expect(contains(msgsAt('error'), 'none of that currency left')).toBe(true);
    });

    test('unknown challenge: nothing dispatched', async () => {
        await cmd('999', { yes: true });
        expect(handlers[channel]).not.toHaveBeenCalled();
    });
});

describe('swap', () => {
    test('without --yes: previews, prints old → new and the exact confirm line', async () => {
        await swapCmd('111', { imageId: 'old1' });
        expect(handlers['swap-entry-photo']).not.toHaveBeenCalled();
        expect(contains(msgsAt('info'), 'old1 → new9')).toBe(true);
        expect(contains(msgsAt('info'), 'swap --challenge=111 --image=old1 --to=new9 --yes')).toBe(true);
    });

    test('--yes with the matching --to swaps', async () => {
        handlers['swap-entry-photo'].mockResolvedValue({ success: true, outcome: 'ok' });
        await swapCmd('111', { imageId: 'old1', to: 'new9', yes: true });
        expect(handlers['swap-entry-photo']).toHaveBeenCalledWith(null, '111', 'old1', 'new9', true);
    });

    test('--yes when the suggestion changed since the preview: refuses, spends nothing', async () => {
        await swapCmd('111', { imageId: 'old1', to: 'different', yes: true });
        expect(handlers['swap-entry-photo']).not.toHaveBeenCalled();
        expect(contains(msgsAt('error'), 'now new9')).toBe(true);
    });

    test('--yes without --to: refuses and names the flag to add', async () => {
        await swapCmd('111', { imageId: 'old1', yes: true });
        expect(handlers['swap-entry-photo']).not.toHaveBeenCalled();
        expect(contains(msgsAt('error'), '--to=new9')).toBe(true);
    });

    test('no alternative: preview failure is reported, nothing spent', async () => {
        handlers['preview-swap-photo'].mockResolvedValue({ success: false, outcome: 'no-alternative' });
        await swapCmd('111', { imageId: 'old1', yes: true });
        expect(handlers['swap-entry-photo']).not.toHaveBeenCalled();
        expect(contains(msgsAt('error'), 'No different photo')).toBe(true);
    });
});

describe('swap-back', () => {
    beforeEach(() => {
        handlers['get-swap-backs'].mockResolvedValue({
            success: true,
            items: [{ currentId: 'repl', previousId: 'orig', previousMemberId: 'm', kind: 'boost' }],
        });
    });

    test('without --yes: names the original and its boost, spends nothing', async () => {
        await swapBackCmd('111', { imageId: 'repl' });
        expect(handlers['swap-back-entry-photo']).not.toHaveBeenCalled();
        expect(contains(msgsAt('info'), 'repl → orig (gets its boost back)')).toBe(true);
        expect(contains(msgsAt('info'), 'swap-back --challenge=111 --image=repl --yes')).toBe(true);
    });

    test('with --yes: swaps back with confirmed=true', async () => {
        handlers['swap-back-entry-photo'].mockResolvedValue({ success: true, outcome: 'ok' });
        await swapBackCmd('111', { imageId: 'repl', yes: true });
        expect(handlers['swap-back-entry-photo']).toHaveBeenCalledWith(null, '111', 'repl', true);
        expect(contains(msgsAt('success'), 'its boost is back')).toBe(true);
    });

    test('no recorded swap back for that photo: reported, nothing spent', async () => {
        await swapBackCmd('111', { imageId: 'other', yes: true });
        expect(handlers['swap-back-entry-photo']).not.toHaveBeenCalled();
        expect(contains(msgsAt('error'), 'No swap back is recorded')).toBe(true);
    });

    test('missing --image is a usage error', async () => {
        expect(await swapBackCmd('111', {})).toBe(false);
    });
});
