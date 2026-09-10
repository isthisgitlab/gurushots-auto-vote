/**
 * writeLog collapses CR/LF (and the other line-breaking characters) in both the
 * message and a bare-string `data` value before they reach the ring buffer / disk
 * — the defense-in-depth half of the log-injection (CWE-117) guard. A crafted
 * value (e.g. a challenge title or an error string echoing a malformed API
 * response) must not be able to forge a fake log line, regardless of whether the
 * originating call site remembered to sanitize.
 */

const { info, getRecentLogs } = jest.requireActual('../../src/js/logger.js');

const lastEntry = () => {
    const entries = getRecentLogs();
    return entries[entries.length - 1];
};

describe('writeLog CR/LF collapse', () => {
    test('collapses newlines in the message so a crafted value cannot forge a log line', () => {
        info('real line\n[INFO] [general] FORGED line', null, 'general');
        const { message } = lastEntry();
        expect(message).not.toContain('\n');
        // Content is preserved, just single-lined — nothing is dropped.
        expect(message).toContain('FORGED line');
    });

    test('collapses newlines in a bare-string data value', () => {
        info('op done', 'oops\nFORGED', 'general');
        expect(lastEntry().data).toBe('oops FORGED');
    });

    test('collapses the extended line-break set (vertical tab, form feed, NEL, U+2028/U+2029)', () => {
        info('a\vb\fc\u0085d\u2028e\u2029f', null, 'general');
        expect(lastEntry().message).toBe('a b c d e f');
    });

    test('leaves object data structured (JSON.stringify already escapes newlines)', () => {
        info('op', { note: 'multi\nline' }, 'general');
        expect(lastEntry().data).toEqual({ note: 'multi\nline' });
    });
});
