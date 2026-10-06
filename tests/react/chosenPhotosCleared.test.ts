/**
 * The announcement that every saved chosen-photos list was removed, and the
 * helper editors use to drop the list from a draft.
 */

import {
    announceChosenPhotosCleared,
    withEmptyChosenPhotos,
    withoutChosenPhotos,
    scenarioWithoutChosenPhotos,
} from '@/api/chosenPhotosCleared';

describe('withoutChosenPhotos', () => {
    test('drops the list and keeps everything else, without touching the original', () => {
        const values = { chosenPhotos: ['a'], exposure: 50 };
        expect(withoutChosenPhotos(values)).toEqual({ exposure: 50 });
        expect(values).toEqual({ chosenPhotos: ['a'], exposure: 50 });
    });

    test('an empty list is dropped too', () => {
        expect(withoutChosenPhotos({ chosenPhotos: [], exposure: 50 })).toEqual({ exposure: 50 });
    });

    test('a map that holds no list comes back as it is', () => {
        const values = { exposure: 50 };
        expect(withoutChosenPhotos(values)).toBe(values);
    });
});

describe('announceChosenPhotosCleared', () => {
    test('with nobody listening it does nothing', () => {
        expect(() => announceChosenPhotosCleared()).not.toThrow();
    });
});

describe('withEmptyChosenPhotos', () => {
    test('empties a list in place of dropping it, and leaves a map without one as it is', () => {
        expect(withEmptyChosenPhotos({ chosenPhotos: ['a'], exposure: 50 })).toEqual({
            chosenPhotos: [],
            exposure: 50,
        });
        const values = { exposure: 50 };
        expect(withEmptyChosenPhotos(values)).toBe(values);
    });
});

describe('scenarioWithoutChosenPhotos', () => {
    test('strips the list from every phase that has settings and leaves the rest', () => {
        const draft = {
            name: 'Plan',
            start: 'main',
            phases: {
                main: { settings: { chosenPhotos: ['a'], exposure: 10 }, rules: [] },
                later: { rules: [] },
            },
        };
        expect(scenarioWithoutChosenPhotos(draft)).toEqual({
            name: 'Plan',
            start: 'main',
            phases: { main: { settings: { exposure: 10 }, rules: [] }, later: { rules: [] } },
        });
    });
});
