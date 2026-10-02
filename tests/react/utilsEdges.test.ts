import { invalid } from '../helpers/invalid';
/**
 * Defensive-input paths of the pure renderer utils that their main suites
 * don't reach: missing collections / member objects, non-Error throws in the
 * deadline notifier, and the sanitizer's anchor / junk-attribute / parser
 * failure handling.
 */

import type * as challengeAlertsModule from '../../src/ts/react/utils/challengeAlerts';
import type * as challengeApplicabilityModule from '../../src/ts/react/utils/challengeApplicability';
import type * as sanitizeWelcomeMessageModule from '../../src/ts/react/utils/sanitizeWelcomeMessage';
import type * as deadlineNotifierModule from '../../src/ts/react/notifications/deadlineNotifier';
const { lowExposureChallenges } = require('../../src/ts/react/utils/challengeAlerts') as typeof challengeAlertsModule;
const { getGroupApplicability } =
    require('../../src/ts/react/utils/challengeApplicability') as typeof challengeApplicabilityModule;
const { sanitizeWelcomeMessage } =
    require('../../src/ts/react/utils/sanitizeWelcomeMessage') as typeof sanitizeWelcomeMessageModule;
const { createDeadlineNotifier } =
    require('../../src/ts/react/notifications/deadlineNotifier') as typeof deadlineNotifierModule;

describe('lowExposureChallenges', () => {
    test('a missing challenge list yields no entries', () => {
        expect(lowExposureChallenges(undefined, 100)).toEqual([]);
        expect(lowExposureChallenges(null, 100)).toEqual([]);
    });
});

describe('getGroupApplicability', () => {
    test('a challenge with no member object is treated as having no entries / boost / turbo state', () => {
        expect(getGroupApplicability('boost', invalid({ type: 'default', max_photo_submits: 4 }))).toEqual({
            applicable: true,
            reasonKey: null,
        });
        expect(getGroupApplicability('autoFill', invalid({ max_photo_submits: 2 }))).toEqual({
            applicable: true,
            reasonKey: null,
        });
    });
});

describe('createDeadlineNotifier failure logging', () => {
    test('a non-Error rejection is logged verbatim', async () => {
        const log = jest.fn();
        const notify = createDeadlineNotifier({
            getSetting: jest.fn().mockRejectedValue('settings offline'),
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
            getSetting: jest.fn().mockRejectedValue(new Error('down')),
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
        global.DOMParser = invalid(function BrokenParser() {
            throw new Error('no DOM');
        });
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
