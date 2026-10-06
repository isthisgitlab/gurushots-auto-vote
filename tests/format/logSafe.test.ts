/**
 * format/logSafe — failureText: the text a failure log line carries for any
 * caught value. It is never empty, because logger.endOperation treats empty
 * error text as a successful completion.
 */

import type * as logSafeModule from '../../src/ts/format/logSafe';

const { failureText, sentenceCaseLogMessage, stripTerminalControl } =
    require('../../src/ts/format/logSafe') as typeof logSafeModule;

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

describe('stripTerminalControl', () => {
    const ESC = String.fromCharCode(27);
    const BEL = String.fromCharCode(7);

    test.each([
        ['plain text', 'Pink Flower', 'Pink Flower'],
        ['a colour sequence', `${ESC}[31;1mred${ESC}[0m`, 'red'],
        ['a cursor move with intermediates', `a${ESC}[?25l${ESC}[2 qb`, 'ab'],
        ['a title sequence ended by BEL', `x${ESC}]0;pwned${BEL}y`, 'xy'],
        ['a title sequence ended by ST', `x${ESC}]0;pwned${ESC}\\y`, 'xy'],
        ['a title sequence with no end', `x${ESC}]0;pwned`, 'x'],
        ['a bare escape', `a${ESC}b`, 'ab'],
        ['line breaks and tabs', 'one\r\ntwo\tthree\u2028four', 'one two three four'],
        ['other control characters, C1 included', `a${BEL}b\u0085c\u009bd`, 'ab cd'],
        ['bidi embeddings, overrides and isolates', 'a\u202Ab\u202Ec\u2066d\u2069e', 'abcde'],
        ['directional marks', 'a\u200Eb\u200Fc\u061Cd', 'abcd'],
        ['zero-width space, word joiner and the BOM', 'a\u200Bb\u2060c\uFEFFd', 'abcd'],
        ['tag characters', 'a\u{E0041}b', 'ab'],
        ['invisible operators', 'a\u2062b', 'ab'],
        ['the soft hyphen', 'a\u00ADb', 'ab'],
        ['interlinear annotation marks', 'a\uFFF9b\uFFFBc', 'abc'],
        [
            'joiners that emoji sequences and Persian text need',
            '👨\u200D👩\u200D👧 می\u200Cخواهم',
            '👨\u200D👩\u200D👧 می\u200Cخواهم',
        ],
        ['a number', 42, '42'],
    ])('%s', (_name, value, expected) => {
        expect(stripTerminalControl(value)).toBe(expected);
    });

    describe('with keepLayout, for a document whose own lines are wanted', () => {
        const keep = (value: unknown) => stripTerminalControl(value, { keepLayout: true });

        test('keeps newlines and tabs, and turns the other line separators into newlines', () => {
            expect(keep('a\nb\tc')).toBe('a\nb\tc');
            expect(keep('a\r\nb\rc\u2028d\u2029e\u0085f\vg\fh')).toBe('a\nb\nc\nd\ne\nf\ng\nh');
        });

        test('still strips every other control and format character, and escape sequences', () => {
            expect(keep(`a${BEL}b${ESC}[31mc${ESC}[0m\u202Ed\u200Be\u00ADf\u{E0041}`)).toBe('abcdef');
            expect(keep('👨\u200D👩 می\u200Cخ')).toBe('👨\u200D👩 می\u200Cخ');
        });
    });
});
