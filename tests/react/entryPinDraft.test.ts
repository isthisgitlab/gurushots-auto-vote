/**
 * The photo chooser's pin draft algebra: the pin a kind would save, the draft after a toggle or after
 * a photo leaves the selection, and the ordered pin writes a save makes for a draft.
 */

import { PIN_KINDS, pinDraftWithout, pinOf, planPinCommits, toggledPinDraft } from '@/utils/entryPinDraft';

import type { EntryPins } from '../../src/ts/types/settings';

const stored = (boost: string | null, turbo: string | null): EntryPins => ({ boost, turbo });

describe('pinOf', () => {
    test('the draft value wins while the kind has one, a drafted clear included', () => {
        expect(pinOf({ boost: 'draft_a' }, stored('stored_a', null), 'boost')).toBe('draft_a');
        expect(pinOf({ boost: null }, stored('stored_a', null), 'boost')).toBeNull();
    });

    test('an absent draft kind reads the stored pin', () => {
        expect(pinOf({}, stored('stored_a', 'stored_b'), 'turbo')).toBe('stored_b');
    });
});

describe('toggledPinDraft', () => {
    test('pinning an unpinned photo drafts the pin', () => {
        expect(toggledPinDraft({}, stored(null, null), 'boost', 'img_a')).toEqual({ boost: 'img_a' });
    });

    test('pinning a photo the other kind has stored gives that pin way, as an explicit clear', () => {
        expect(toggledPinDraft({}, stored(null, 'img_a'), 'boost', 'img_a')).toEqual({ boost: 'img_a', turbo: null });
        expect(toggledPinDraft({}, stored('img_a', null), 'turbo', 'img_a')).toEqual({ boost: null, turbo: 'img_a' });
    });

    test('the other kind’s pin gives way from the draft too, vanishing where nothing is stored to clear', () => {
        expect(toggledPinDraft({ turbo: 'img_a' }, stored(null, null), 'boost', 'img_a')).toEqual({ boost: 'img_a' });
    });

    test('the give-away keeps its explicit clear while the stored pin still holds it', () => {
        expect(toggledPinDraft({ turbo: 'img_a' }, stored(null, 'img_a'), 'boost', 'img_a')).toEqual({
            boost: 'img_a',
            turbo: null,
        });
    });

    test('a different photo on the other kind stays, and an earlier explicit clear survives', () => {
        expect(toggledPinDraft({}, stored(null, 'img_b'), 'boost', 'img_a')).toEqual({ boost: 'img_a' });
        expect(toggledPinDraft({ turbo: null }, stored(null, 'img_b'), 'boost', 'img_a')).toEqual({
            boost: 'img_a',
            turbo: null,
        });
    });

    test('toggling the pinned photo off drafts its clear', () => {
        expect(toggledPinDraft({}, stored('img_a', null), 'boost', 'img_a')).toEqual({ boost: null });
        expect(toggledPinDraft({ turbo: 'img_b' }, stored(null, 'img_b'), 'turbo', 'img_b')).toEqual({ turbo: null });
    });

    test('a toggle taken back to the stored pin drafts nothing', () => {
        expect(toggledPinDraft({ boost: null }, stored('img_a', null), 'boost', 'img_a')).toEqual({});
    });

    test('a drafted pin dropped back to a null stored pin drafts nothing either', () => {
        expect(toggledPinDraft({ boost: 'img_a' }, stored(null, null), 'boost', 'img_a')).toEqual({});
    });
});

describe('pinDraftWithout', () => {
    test('drops only the draft pins naming the photo that left', () => {
        expect(pinDraftWithout({ boost: 'img_a', turbo: 'img_b' }, 'img_a')).toEqual({ turbo: 'img_b' });
        expect(pinDraftWithout({ boost: 'img_a', turbo: null }, 'img_a')).toEqual({ turbo: null });
    });

    test('leaves draft pins naming other photos, and an empty draft alone', () => {
        expect(pinDraftWithout({ boost: 'img_a' }, 'img_b')).toEqual({ boost: 'img_a' });
        expect(pinDraftWithout({}, 'img_a')).toEqual({});
    });
});

describe('planPinCommits', () => {
    test('one write per changed kind, in save order', () => {
        expect(PIN_KINDS).toEqual(['boost', 'turbo']);
        expect(planPinCommits({ boost: 'img_a', turbo: 'img_b' }, stored(null, null))).toEqual([
            { kind: 'boost', imageId: 'img_a' },
            { kind: 'turbo', imageId: 'img_b' },
        ]);
    });

    test('a kind the draft leaves alone is not written', () => {
        expect(planPinCommits({}, stored('img_a', 'img_b'))).toEqual([]);
    });

    test('a swap sends one write: the moved null is skipped while the other kind names the photo', () => {
        expect(planPinCommits({ boost: 'img_a', turbo: null }, stored(null, 'img_a'))).toEqual([
            { kind: 'boost', imageId: 'img_a' },
        ]);
    });

    test('a clear that is not the moved half of a swap is written', () => {
        expect(planPinCommits({ boost: null, turbo: 'img_b' }, stored('img_a', null))).toEqual([
            { kind: 'boost', imageId: null },
            { kind: 'turbo', imageId: 'img_b' },
        ]);
        expect(planPinCommits({ boost: null }, stored('img_a', null))).toEqual([{ kind: 'boost', imageId: null }]);
    });
});
