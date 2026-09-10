const { isSafeExternalUrl } = require('../../src/js/format/urlSafe');

describe('isSafeExternalUrl', () => {
    test('accepts well-formed https URLs', () => {
        expect(isSafeExternalUrl('https://gurushots.com/x')).toBe(true);
        expect(isSafeExternalUrl('https://github.com/isthisgitlab/gurushots-auto-vote/releases')).toBe(true);
    });

    test('rejects every non-https scheme', () => {
        for (const url of [
            'http://gurushots.com',
            'file:///etc/passwd',
            'javascript:alert(1)',
            'intent://scan/#Intent;scheme=x;end',
            'data:text/html,<script>alert(1)</script>',
            'ftp://example.com',
            'HTTPS://example.com', // scheme match is case-sensitive by design (startsWith)
        ]) {
            expect(isSafeExternalUrl(url)).toBe(false);
        }
    });

    test('rejects non-string / empty input', () => {
        expect(isSafeExternalUrl(null)).toBe(false);
        expect(isSafeExternalUrl(undefined)).toBe(false);
        expect(isSafeExternalUrl(123)).toBe(false);
        expect(isSafeExternalUrl('')).toBe(false);
        expect(isSafeExternalUrl({})).toBe(false);
    });
});
