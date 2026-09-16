const { buildPhotoUrl, entryPhotoUrl } = require('../../src/js/format/photoUrl');

// A real member/photo id pair, shaped exactly like the API returns them.
const MEMBER = 'c1d1f7733b10b21459a3a86c5162efa9';
const IMAGE = 'ee794fe28b178f7201ee9c8b7efde408';

describe('buildPhotoUrl', () => {
    it('builds the CDN URL the site itself serves', () => {
        expect(buildPhotoUrl(MEMBER, IMAGE, { size: 500 })).toBe(
            `https://photos.gurushots.com/unsafe/500x500/${MEMBER}/3_${IMAGE}.jpg`,
        );
    });

    it('uses fit-in when asked, so the whole frame is visible', () => {
        expect(buildPhotoUrl(MEMBER, IMAGE, { size: 400, fit: true })).toBe(
            `https://photos.gurushots.com/unsafe/fit-in/400x400/${MEMBER}/3_${IMAGE}.jpg`,
        );
    });

    it('defaults to a 200px square', () => {
        expect(buildPhotoUrl(MEMBER, IMAGE)).toContain('/unsafe/200x200/');
    });

    it('clamps an oversized request instead of forwarding it to the origin', () => {
        expect(buildPhotoUrl(MEMBER, IMAGE, { size: 99999 })).toContain('/unsafe/2000x2000/');
    });

    it.each([
        ['a non-integer size', { size: 12.6 }, '/unsafe/13x13/'],
        ['a zero size', { size: 0 }, '/unsafe/200x200/'],
        ['a negative size', { size: -50 }, '/unsafe/200x200/'],
        ['a NaN size', { size: Number.NaN }, '/unsafe/200x200/'],
    ])('handles %s', (_label, options, expected) => {
        expect(buildPhotoUrl(MEMBER, IMAGE, options)).toContain(expected);
    });

    // The ids are interpolated straight into a URL path, so a malformed one
    // must never reach the string — see the ID_PATTERN comment in the module.
    describe('rejects ids that are not 32-char hex', () => {
        it.each([
            ['path traversal', '../../evil', IMAGE],
            ['host takeover via userinfo', `${MEMBER}@evil.com`, IMAGE],
            ['a query-string break-out', MEMBER, `${IMAGE}?x=`],
            ['an empty member id', '', IMAGE],
            ['an empty image id', MEMBER, ''],
            ['a too-short id', 'abc123', IMAGE],
            ['non-hex characters', 'z'.repeat(32), IMAGE],
            ['null', null, IMAGE],
            ['undefined', undefined, IMAGE],
            ['a number', 12345, IMAGE],
        ])('%s', (_label, memberId, imageId) => {
            expect(buildPhotoUrl(memberId, imageId)).toBeNull();
        });
    });

    it('accepts uppercase hex', () => {
        expect(buildPhotoUrl(MEMBER.toUpperCase(), IMAGE.toUpperCase())).not.toBeNull();
    });
});

describe('entryPhotoUrl', () => {
    it('reads member_id and id off an entry record', () => {
        const entry = { id: IMAGE, member_id: MEMBER, rank: 748, votes: 746 };
        expect(entryPhotoUrl(entry, { size: 56 })).toBe(
            `https://photos.gurushots.com/unsafe/56x56/${MEMBER}/3_${IMAGE}.jpg`,
        );
    });

    // A per-challenge API read that comes back shaped differently must degrade
    // to "no thumbnail", never throw into the renderer.
    it.each([
        ['null', null],
        ['undefined', undefined],
        ['an empty object', {}],
        ['an entry missing member_id', { id: IMAGE }],
        ['an entry missing id', { member_id: MEMBER }],
    ])('returns null for %s', (_label, entry) => {
        expect(entryPhotoUrl(entry)).toBeNull();
    });
});
