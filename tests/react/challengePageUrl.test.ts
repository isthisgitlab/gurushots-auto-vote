import { challengePageUrl } from '@/utils/challengePageUrl';

describe('challengePageUrl', () => {
    test.each(['sunset', 'harbour-lights', 'Flash_2026', 'a1-B2_c3'])(
        'opens the challenge page for the slug %s',
        (slug) => {
            expect(challengePageUrl(slug)).toBe(`https://gurushots.com/challenge/${slug}`);
        },
    );

    test.each([
        ['an empty slug', ''],
        ['a path walk', '../../account'],
        ['a slash', 'a/b'],
        ['a query', 'x?y=1'],
        ['a fragment', 'x#y'],
        ['a userinfo lookalike', '@evil.example'],
        ['spaces', 'a b'],
        ['a newline after a valid slug', 'abc\n'],
        ['non-word letters', 'čau'],
        ['no slug', null],
        ['an undefined slug', undefined],
    ])('falls back to the generic challenges page for %s', (_name, slug) => {
        expect(challengePageUrl(slug)).toBe('https://gurushots.com/challenges');
    });
});
