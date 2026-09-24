/**
 * Coverage for the Node OS-delivery seams that the injected-`deliver` tests in
 * nodeNotify.test.js bypass: the real execFile branching per platform (and its
 * error-swallow), the Node-side i18n resolver, and the re-entrancy guard.
 */

jest.mock('node:child_process', () => ({ execFile: jest.fn() }));
jest.mock('../../src/js/settings', () => ({
    getSetting: jest.fn(() => 'en'),
    loadSettings: jest.fn(() => ({})),
    getEffectiveSetting: jest.fn(),
}));

jest.mock('../../src/js/services/VotingLogic', () => ({ describeDeadlineActions: jest.fn() }));

const { execFile } = require('node:child_process');
const votingLogic = require('../../src/js/services/VotingLogic');
const logger = require('../../src/js/logger');
const settings = require('../../src/js/settings');
const {
    createNodeDeadlineNotifier,
    deliverOsNotification,
    nodeTranslate,
} = require('../../src/js/services/notify/nodeNotify');

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
const setPlatform = (value) => Object.defineProperty(process, 'platform', { value, configurable: true });
afterAll(() => Object.defineProperty(process, 'platform', originalPlatform));
beforeEach(() => jest.clearAllMocks());

describe('deliverOsNotification', () => {
    test('macOS → osascript display notification via execFile (argv, no shell)', () => {
        setPlatform('darwin');
        deliverOsNotification({ title: 'Boost', body: 'in 5 min' });
        expect(execFile).toHaveBeenCalledTimes(1);
        const [cmd, args] = execFile.mock.calls[0];
        expect(cmd).toBe('osascript');
        expect(args[0]).toBe('-e');
        expect(args[1]).toBe('display notification "in 5 min" with title "Boost"');
        // The completion callback deliberately ignores spawn errors.
        expect(execFile.mock.calls[0][2](new Error('osascript failed'))).toBeUndefined();
    });

    test('Linux → notify-send with -- guard, title and body as argv', () => {
        setPlatform('linux');
        deliverOsNotification({ title: 'Boost', body: 'in 5 min' });
        expect(execFile).toHaveBeenCalledWith('notify-send', ['--', 'Boost', 'in 5 min'], expect.any(Function));
        expect(execFile.mock.calls[0][2](new Error('ENOENT'))).toBeUndefined();
    });

    test('other platforms → no spawn', () => {
        setPlatform('win32');
        deliverOsNotification({ title: 'x', body: 'y' });
        expect(execFile).not.toHaveBeenCalled();
    });

    test('a synchronous spawn error is swallowed (best-effort, never throws)', () => {
        setPlatform('linux');
        execFile.mockImplementationOnce(() => {
            throw new Error('notify-send missing');
        });
        expect(() => deliverOsNotification({ title: 'x', body: 'y' })).not.toThrow();
    });
});

describe('nodeTranslate', () => {
    test('resolves a real English template for a dotted key', () => {
        settings.getSetting.mockReturnValue('en');
        expect(nodeTranslate('app.notifyBody')).toContain('{minutes}');
    });

    test('resolves the Latvian template when the language is lv', () => {
        settings.getSetting.mockReturnValue('lv');
        const lv = nodeTranslate('app.notifyBody');
        expect(typeof lv).toBe('string');
        expect(lv).toContain('{minutes}');
    });

    test('a key naming a section rather than a string falls back to the key itself', () => {
        settings.getSetting.mockReturnValue('en');
        expect(nodeTranslate('app')).toBe('app');
    });

    test('an unresolvable key falls back to the key itself', () => {
        settings.getSetting.mockReturnValue('en');
        expect(nodeTranslate('app.nope.notAKey')).toBe('app.nope.notAKey');
    });
});

describe('nodeTranslate fault tolerance', () => {
    test('falls back to the key when the settings facade throws', () => {
        settings.getSetting.mockImplementationOnce(() => {
            throw new Error('settings unreadable');
        });
        expect(nodeTranslate('app.notifyBody')).toBe('app.notifyBody');
    });
});

describe('createNodeDeadlineNotifier (default wiring)', () => {
    const NOW = 1_000_000;
    const store = { notifyOnBoost: true, notifyLeadTime: 10, language: 'en' };

    beforeEach(() => {
        settings.getSetting.mockImplementation((key) => store[key]);
        setPlatform('linux');
    });

    test('uses the settings facade, VotingLogic, the Node translator and OS delivery by default', async () => {
        votingLogic.describeDeadlineActions.mockReturnValue({ actions: [{ action: 'boost', dueAt: NOW + 120 }] });
        const notify = createNodeDeadlineNotifier();

        await notify([{ id: 'c1', title: 'Sunset' }], NOW);

        expect(votingLogic.describeDeadlineActions).toHaveBeenCalledWith({ id: 'c1', title: 'Sunset' }, NOW);
        expect(execFile).toHaveBeenCalledTimes(1);
        const [cmd, args] = execFile.mock.calls[0];
        expect(cmd).toBe('notify-send');
        expect(args[0]).toBe('--');
        // The translated (English) body mentions the challenge title.
        expect(args[2]).toContain('Sunset');
    });

    test('tolerates a non-array challenge list, missing describe results and non-array actions', async () => {
        const deliver = jest.fn();
        const describeDeadlineActions = jest.fn().mockReturnValueOnce(undefined).mockReturnValueOnce({ actions: 'x' });
        const notify = createNodeDeadlineNotifier({ describeDeadlineActions, deliver });

        await notify(null, NOW);
        expect(describeDeadlineActions).not.toHaveBeenCalled();

        await notify([{ id: 'a' }, { id: 'b' }], NOW);
        expect(describeDeadlineActions).toHaveBeenCalledTimes(2);
        expect(deliver).not.toHaveBeenCalled();
    });

    test('ignores a re-entrant call made while a cycle is still running', async () => {
        let notify;
        const describeDeadlineActions = jest.fn(() => ({ actions: [{ action: 'boost', dueAt: NOW + 60 }] }));
        const deliver = jest.fn(() => notify([{ id: 'nested' }], NOW));
        notify = createNodeDeadlineNotifier({ describeDeadlineActions, deliver, translate: (k) => k });

        await notify([{ id: 'outer' }], NOW);

        expect(deliver).toHaveBeenCalledTimes(1);
        expect(describeDeadlineActions).toHaveBeenCalledTimes(1);
        expect(describeDeadlineActions).toHaveBeenCalledWith({ id: 'outer' }, NOW);
    });

    test('swallows a failing cycle and logs Error messages and non-Error throws alike', async () => {
        const debug = jest.fn();
        logger.withCategory.mockReturnValueOnce({ debug }).mockReturnValueOnce({ debug });
        const deliver = jest.fn(() => {
            throw new Error('spawn blew up');
        });
        const notify = createNodeDeadlineNotifier({
            describeDeadlineActions: () => ({ actions: [{ action: 'boost', dueAt: NOW + 60 }] }),
            deliver,
            translate: (k) => k,
        });

        await expect(notify([{ id: 'c1' }], NOW)).resolves.toBeUndefined();
        expect(debug).toHaveBeenCalledWith('deadline notification cycle failed', 'spawn blew up');

        const stringThrower = createNodeDeadlineNotifier({
            getSetting: () => {
                throw 'settings gone';
            },
        });
        await expect(stringThrower([], NOW)).resolves.toBeUndefined();
        expect(debug).toHaveBeenCalledWith('deadline notification cycle failed', 'settings gone');

        // The guard is released after a failure: the next cycle runs again.
        deliver.mockImplementationOnce(() => {});
        await notify([{ id: 'c2' }], NOW);
        expect(deliver).toHaveBeenCalledTimes(2);
    });
});
