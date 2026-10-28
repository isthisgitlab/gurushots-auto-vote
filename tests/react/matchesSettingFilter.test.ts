import { matchesFilterTexts, matchesSettingFilter } from '../../src/ts/react/utils/matchesSettingFilter';

describe('matchesSettingFilter', () => {
    test('a blank query matches everything', () => {
        expect(matchesSettingFilter(['Exposure'], '')).toBe(true);
        expect(matchesSettingFilter([], '   ')).toBe(true);
    });

    test('matches any of the texts, as a substring, without case', () => {
        expect(matchesSettingFilter(['Exposure target', 'How much to vote'], 'EXPO')).toBe(true);
        expect(matchesSettingFilter(['Exposure target', 'How much to vote'], 'much to')).toBe(true);
        expect(matchesSettingFilter(['Exposure target', 'How much to vote'], 'turbo')).toBe(false);
        expect(matchesSettingFilter([], 'a')).toBe(false);
    });

    test('ignores accents on both sides', () => {
        expect(matchesSettingFilter(['Ātrums', 'Laika josla'], 'atrums')).toBe(true);
        expect(matchesSettingFilter(['Atrums'], 'Ātr')).toBe(true);
        expect(matchesSettingFilter(['Ģimene, žāvēts'], 'gimene, zav')).toBe(true);
    });

    test('searches for the query as text, never as a pattern', () => {
        expect(matchesSettingFilter(['Retry (max)'], '(max')).toBe(true);
        expect(matchesSettingFilter(['Retry max'], '.*')).toBe(false);
        expect(matchesSettingFilter(['Retry max'], '(')).toBe(false);
    });
});

describe('matchesFilterTexts', () => {
    const texts = { names: ['Ekspozīcija'], descriptions: ['How much of the challenge to vote on'] };

    test('matches a name in both modes', () => {
        expect(matchesFilterTexts(texts, 'ekspoz', true)).toBe(true);
        expect(matchesFilterTexts(texts, 'EKSPOZ', false)).toBe(true);
    });

    test('matches a description only when namesOnly is false', () => {
        expect(matchesFilterTexts(texts, 'much of the challenge', true)).toBe(false);
        expect(matchesFilterTexts(texts, 'much of the challenge', false)).toBe(true);
    });

    test('a blank query matches in both modes', () => {
        expect(matchesFilterTexts(texts, '', true)).toBe(true);
        expect(matchesFilterTexts({ names: [], descriptions: [] }, '   ', false)).toBe(true);
    });
});
