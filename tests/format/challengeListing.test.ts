/**
 * challengeListing: what a Discover row and the CLI `discover` say about a challenge besides its title: its type
 * (else its badge), the photos it takes, and its tags, each read defensively from a server payload.
 */

import { challengeKind, challengePhotoCount, listedTags, stringTags } from '../../src/ts/format/challengeListing';
import { invalid } from '../helpers/invalid';

describe('challengeKind', () => {
    test('is the type, else the badge, trimmed', () => {
        expect(challengeKind({ type: ' flash ', badge: 'Special' })).toEqual({ label: 'flash', isType: true });
        expect(challengeKind({ type: '', badge: ' Special ' })).toEqual({ label: 'Special', isType: false });
        expect(challengeKind({ badge: 'Special' })).toEqual({ label: 'Special', isType: false });
    });

    test.each([[null], [undefined], [{}], [{ type: '  ', badge: null }], [{ type: 7, badge: { a: 1 } }]])(
        'is null for %j: nothing to show',
        (challenge) => {
            expect(challengeKind(invalid(challenge))).toBeNull();
        },
    );

    test('a type that is not text is skipped for the badge', () => {
        expect(challengeKind(invalid({ type: 7, badge: 'Special' }))).toEqual({ label: 'Special', isType: false });
    });
});

describe('challengePhotoCount', () => {
    test.each([
        [{ max_photo_submits: 2 }, 2],
        [{ max_photo_submits: '4' }, 4],
        [{ max_photo_submits: 1 }, null],
        [{ max_photo_submits: 2.5 }, null],
        [{ max_photo_submits: Infinity }, null],
        [{ max_photo_submits: -3 }, null],
        [{ max_photo_submits: 0 }, null],
        [{ max_photo_submits: 'x' }, null],
        [{ max_photo_submits: null }, null],
        [{}, null],
        [null, null],
    ])('%j is %p', (challenge, count) => {
        expect(challengePhotoCount(invalid(challenge))).toBe(count);
    });
});

describe('listedTags', () => {
    test('keeps the tags as written, trimmed, in order', () => {
        expect(listedTags({ tags: ['Exhibition', ' No comm '] })).toEqual(['Exhibition', 'No comm']);
    });

    test('drops blanks, non-text values and a tag that repeats the type or the badge shown (any case)', () => {
        expect(listedTags(invalid({ type: 'default', tags: ['Default', 'Comm', '', '  ', 7, null, {}] }))).toEqual([
            'Comm',
        ]);
        expect(listedTags({ type: '', badge: 'Team match', tags: ['TEAM MATCH', 'Comm'] })).toEqual(['Comm']);
        // The badge is only shown when there is no type: with a type, a tag equal to the badge stays.
        expect(listedTags({ type: 'flash', badge: 'Special', tags: ['Special'] })).toEqual(['Special']);
    });

    test('drops a photo-count tag, which the listing says itself from the photo count', () => {
        expect(listedTags({ tags: ['3 photos', '1 Photo', '12 PHOTOS', '3 photos long', 'Comm'] })).toEqual([
            '3 photos long',
            'Comm',
        ]);
    });

    test.each([['Exhibition'], [7], [{ 0: 'a' }], [null], [undefined]])('a tags value of %j shows none', (tags) => {
        expect(listedTags(invalid({ tags }))).toEqual([]);
    });

    test('stringTags keeps every text tag, repeats of the kind and photo-count tags included', () => {
        expect(stringTags({ type: 'flash', tags: ['FLASH', '4 photos', ' Comm ', '', 7] })).toEqual([
            'FLASH',
            '4 photos',
            'Comm',
        ]);
        expect(stringTags(invalid({ tags: 'Comm' }))).toEqual([]);
        expect(stringTags(invalid({ tags: { 0: 'Comm' } }))).toEqual([]);
        expect(stringTags(null)).toEqual([]);
    });

    test('a challenge that is not an object shows none', () => {
        expect(listedTags(null)).toEqual([]);
        expect(listedTags(undefined)).toEqual([]);
    });
});
