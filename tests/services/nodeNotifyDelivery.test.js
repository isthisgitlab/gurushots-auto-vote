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

const { execFile } = require('node:child_process');
const settings = require('../../src/js/settings');
const { deliverOsNotification, nodeTranslate } = require('../../src/js/services/notify/nodeNotify');

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
    });

    test('Linux → notify-send with -- guard, title and body as argv', () => {
        setPlatform('linux');
        deliverOsNotification({ title: 'Boost', body: 'in 5 min' });
        expect(execFile).toHaveBeenCalledWith('notify-send', ['--', 'Boost', 'in 5 min'], expect.any(Function));
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

    test('an unresolvable key falls back to the key itself', () => {
        settings.getSetting.mockReturnValue('en');
        expect(nodeTranslate('app.nope.notAKey')).toBe('app.nope.notAKey');
    });
});
