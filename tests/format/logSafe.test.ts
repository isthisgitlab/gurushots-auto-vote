/**
 * format/logSafe — failureText: the text a failure log line carries for any
 * caught value. It is never empty, because logger.endOperation treats empty
 * error text as a successful completion.
 */

import type * as logSafeModule from '../../src/ts/format/logSafe';

const { failureText, sentenceCaseLogMessage } = require('../../src/ts/format/logSafe') as typeof logSafeModule;

describe('sentenceCaseLogMessage', () => {
    test.each([
        ['ℹ️ joining up to 4 challenge(s)', 'ℹ️ Joining up to 4 challenge(s)'],
        ['✅ retrieved 24 challenges (1734ms)', '✅ Retrieved 24 challenges (1734ms)'],
        ['🔄 Voting process...', '🔄 Voting process...'],
        ['⚠️ neizdevās ielādēt', '⚠️ Neizdevās ielādēt'],
        ['  indented CLI row', '  indented CLI row'],
        ['ℹ️ macOS detected', 'ℹ️ macOS detected'],
        ['ℹ️ https://example.com', 'ℹ️ https://example.com'],
        ['ℹ️ metadata.votes is invalid', 'ℹ️ metadata.votes is invalid'],
        ['ℹ️ played=3', 'ℹ️ played=3'],
        ['ℹ️ manualFill: submitted an entry', 'ℹ️ manualFill: Submitted an entry'],
        ['⚠️ setTitleRules rejected', '⚠️ setTitleRules: Rejected'],
        ['⚠️ swap-back ledger unreadable', '⚠️ swap-back: Ledger unreadable'],
        ['⚠️ swap: no different photo', '⚠️ swap: No different photo'],
        ['ℹ️ main: Command is:', 'ℹ️ main: Command is:'],
        ['ℹ️ autoFill', 'ℹ️ autoFill'],
        ['ℹ️ [Challenge 12: Sunset] voted for 3 photos', 'ℹ️ [Challenge 12: Sunset] Voted for 3 photos'],
        ['[Challenge 12: Sunset] turbo fill-new unavailable', '[Challenge 12: Sunset] Turbo fill-new unavailable'],
        ['', ''],
    ])('%s → %s', (message, expected) => {
        expect(sentenceCaseLogMessage(message)).toBe(expected);
    });
});

describe('failureText', () => {
    test.each([
        ['an Error with a message', new Error('offline'), 'offline'],
        ['an object with a non-string message', { message: 503 }, '503'],
        ['an Error without a message', new Error(''), 'Error'],
        ['a bare string', 'boom', 'boom'],
        ['null', null, 'unknown error'],
        ['undefined', undefined, 'unknown error'],
        ['an empty string', '', 'unknown error'],
    ])('%s → %p', (_label, error, expected) => {
        expect(failureText(error)).toBe(expected);
    });
});
