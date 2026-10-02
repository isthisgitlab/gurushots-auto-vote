import type * as urlSafeModule from '../../src/ts/format/urlSafe';
const { isSafeExternalUrl, isOpenableLinkUrl } = require('../../src/ts/format/urlSafe') as typeof urlSafeModule;

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

    test('rejects https URLs with embedded credentials (lookalike-host vector)', () => {
        expect(isSafeExternalUrl('https://gurushots.com@evil.com/')).toBe(false);
        expect(isSafeExternalUrl('https://user:pass@evil.com/')).toBe(false);
        expect(isSafeExternalUrl('https://user@evil.com')).toBe(false);
    });

    test('rejects malformed https strings that do not parse as URLs', () => {
        expect(isSafeExternalUrl('https://')).toBe(false);
        expect(isSafeExternalUrl('https:// space.com')).toBe(false);
    });

    test('rejects non-string / empty input', () => {
        expect(isSafeExternalUrl(null)).toBe(false);
        expect(isSafeExternalUrl(undefined)).toBe(false);
        expect(isSafeExternalUrl(123)).toBe(false);
        expect(isSafeExternalUrl('')).toBe(false);
        expect(isSafeExternalUrl({})).toBe(false);
    });
});

describe('isOpenableLinkUrl', () => {
    test('accepts https, http and mailto links', () => {
        expect(isOpenableLinkUrl('https://gurushots.com/x?y=1#z')).toBe(true);
        expect(isOpenableLinkUrl('http://example.com/')).toBe(true);
        expect(isOpenableLinkUrl('HTTP://EXAMPLE.com/')).toBe(true);
        expect(isOpenableLinkUrl('mailto:someone@example.com?subject=Hi')).toBe(true);
    });

    test('rejects every other scheme', () => {
        for (const url of [
            'file:///etc/passwd',
            'javascript:alert(1)',
            'data:text/html,<script>alert(1)</script>',
            'intent://scan/#Intent;scheme=x;end',
            'ftp://example.com',
            'tel:+371000000',
            'blob:https://example.com/id',
        ]) {
            expect(isOpenableLinkUrl(url)).toBe(false);
        }
    });

    test('rejects web URLs with embedded credentials', () => {
        expect(isOpenableLinkUrl('https://gurushots.com@evil.com/')).toBe(false);
        expect(isOpenableLinkUrl('http://user:pass@evil.com/')).toBe(false);
    });

    test('rejects strings that do not parse as URLs', () => {
        expect(isOpenableLinkUrl('')).toBe(false);
        expect(isOpenableLinkUrl('not a url')).toBe(false);
        expect(isOpenableLinkUrl('https://')).toBe(false);
    });
});
