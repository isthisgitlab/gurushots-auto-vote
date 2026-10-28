/**
 * `suggestedTags`: the tag-suggestion selection shared by the picker's search box
 * and the CLI `list-photos --search` — the tag equal to the term is hidden, the
 * reply's order is kept, and the list is capped at MAX_TAG_SUGGESTIONS.
 */

import { MAX_TAG_SUGGESTIONS, suggestedTags } from '../src/ts/tagSuggestions';

describe('suggestedTags', () => {
    test('hides the tag equal to the term both ways: case-insensitively and with surrounding spaces', () => {
        expect(suggestedTags(['Staircase', 'stairs'], ' staircase ')).toEqual(['stairs']);
        expect(suggestedTags(['staircase'], ' STAIRCASE ')).toEqual([]);
    });

    test('keeps the order the reply gave', () => {
        expect(suggestedTags(['zebra', 'apple', 'melon'], 'q')).toEqual(['zebra', 'apple', 'melon']);
    });

    test('caps at MAX_TAG_SUGGESTIONS, exactly 8 of 9+', () => {
        const nine: string[] = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8', 'a9', 'a10'];
        expect(suggestedTags(nine, 'a')).toEqual(['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8']);
        expect(suggestedTags(nine, 'a')).toHaveLength(MAX_TAG_SUGGESTIONS);
        expect(MAX_TAG_SUGGESTIONS).toBe(8);
    });
});
