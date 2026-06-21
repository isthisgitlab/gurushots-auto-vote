/**
 * challengeTag formats a challenge as the `[Challenge {id}: {title}]` log prefix.
 * id/title come from the GuruShots API (untrusted), so CR/LF must be collapsed
 * to a space before interpolation — otherwise a newline in a title could forge a
 * synthetic log line (log injection) in the plain-text log file.
 */

const { challengeTag } = jest.requireActual('../../src/js/logger.js');

describe('challengeTag', () => {
    test('formats a challenge object', () => {
        expect(challengeTag({ id: 'c1', title: 'Pink In Nature' })).toBe('[Challenge c1: Pink In Nature]');
    });

    test('formats (id, title) positional args', () => {
        expect(challengeTag('c2', 'Begins With L')).toBe('[Challenge c2: Begins With L]');
    });

    test('renders missing fields as unknown', () => {
        expect(challengeTag({})).toBe('[Challenge unknown: unknown]');
        expect(challengeTag(null)).toBe('[Challenge unknown: unknown]');
    });

    test('collapses CR/LF in the title to prevent log injection', () => {
        const injected = 'Sunsets\n[2026-01-01] [ERROR] [auth] token=abc';
        expect(challengeTag({ id: 'c3', title: injected })).toBe(
            '[Challenge c3: Sunsets [2026-01-01] [ERROR] [auth] token=abc]',
        );
        // No raw newline survives into the formatted prefix.
        expect(challengeTag({ id: 'c3', title: injected })).not.toMatch(/[\r\n]/);
    });

    test('collapses CR/LF in positional id and title', () => {
        expect(challengeTag('c4\nfake', 'a\r\nb')).toBe('[Challenge c4 fake: a b]');
    });
});
