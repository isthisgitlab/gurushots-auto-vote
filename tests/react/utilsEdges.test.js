/**
 * Defensive-input paths of the pure renderer utils that their main suites
 * don't reach: missing collections / member objects, non-Error throws in the
 * deadline notifier, and the sanitizer's anchor / junk-attribute / parser
 * failure handling.
 */
const { lowExposureChallenges } = require('../../src/js/react/utils/challengeAlerts');
const { getGroupApplicability } = require('../../src/js/react/utils/challengeApplicability');
const { sanitizeWelcomeMessage } = require('../../src/js/react/utils/sanitizeWelcomeMessage');
const { createDeadlineNotifier } = require('../../src/js/react/notifications/deadlineNotifier');

describe('lowExposureChallenges', () => {
    test('a missing challenge list yields no entries', () => {
        expect(lowExposureChallenges(undefined, 100)).toEqual([]);
        expect(lowExposureChallenges(null, 100)).toEqual([]);
    });
});

describe('getGroupApplicability', () => {
    test('a challenge with no member object is treated as having no entries / boost / turbo state', () => {
        expect(getGroupApplicability('boost', { type: 'default', max_photo_submits: 4 })).toEqual({
            applicable: true,
            reasonKey: null,
        });
        expect(getGroupApplicability('autoFill', { max_photo_submits: 2 })).toEqual({
            applicable: true,
            reasonKey: null,
        });
    });
});

describe('createDeadlineNotifier failure logging', () => {
    test('a non-Error rejection is logged verbatim', async () => {
        const log = jest.fn();
        const notify = createDeadlineNotifier({
            getSettings: jest.fn().mockRejectedValue('settings offline'),
            getDeadlineActions: jest.fn(),
            translate: (k) => k,
            deliver: jest.fn(),
            log,
        });
        await notify([], 0);
        expect(log).toHaveBeenCalledWith('deadline notification cycle failed: settings offline');
    });

    test('a throwing log sink is itself swallowed', async () => {
        const notify = createDeadlineNotifier({
            getSettings: jest.fn().mockRejectedValue(new Error('down')),
            getDeadlineActions: jest.fn(),
            translate: (k) => k,
            deliver: jest.fn(),
            log: () => {
                throw new Error('sink broken');
            },
        });
        await expect(notify([], 0)).resolves.toBeUndefined();
    });
});

describe('sanitizeWelcomeMessage edges', () => {
    test('an allowed element carrying medium-editor data-action is dropped with its contents', () => {
        expect(sanitizeWelcomeMessage('<p>keep</p><span data-action="bold">junk</span>')).toBe('<p>keep</p>');
    });

    test('an anchor without href keeps its text but gets no link attributes', () => {
        expect(sanitizeWelcomeMessage('<a name="x">anchor text</a>')).toBe('<a>anchor text</a>');
    });

    test('an anchor with an unsafe href is neutralised', () => {
        expect(sanitizeWelcomeMessage('<a href="javascript:alert(1)">bad</a>')).toBe('<a>bad</a>');
    });

    test('if the DOM parser is unavailable, tags are stripped and the text escaped', () => {
        const original = global.DOMParser;
        global.DOMParser = function BrokenParser() {
            throw new Error('no DOM');
        };
        try {
            expect(sanitizeWelcomeMessage('<b>Hi</b> & "you" <x>')).toBe('Hi &amp; &quot;you&quot; ');
            expect(sanitizeWelcomeMessage('a > b')).toBe('a &gt; b');
            // Nested fragments never reassemble into a live tag.
            expect(sanitizeWelcomeMessage('<scr<b>ipt>alert(1)</script>')).toBe('ipt&gt;alert(1)');
        } finally {
            global.DOMParser = original;
        }
    });
});
