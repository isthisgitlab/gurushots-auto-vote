/**
 * The announcement that every saved chosen-photos list was removed, and the
 * helper editors use to drop the list from a draft.
 */

import { act, renderHook } from '@testing-library/preact';
import { fireSettingsChanged, mockApi } from './helpers/setup';
import { invalid } from '../helpers/invalid';
import {
    announceChosenPhotosCleared,
    useOnChosenPhotosCleared,
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

describe('useOnChosenPhotosCleared', () => {
    test('runs for an announcement while mounted, and stops after unmount', () => {
        const onCleared = jest.fn();
        const { unmount } = renderHook(() => useOnChosenPhotosCleared(onCleared));
        announceChosenPhotosCleared();
        expect(onCleared).toHaveBeenCalledTimes(1);
        unmount();
        announceChosenPhotosCleared();
        expect(onCleared).toHaveBeenCalledTimes(1);
    });

    test('with nobody mounted an announcement reaches no one', () => {
        const onCleared = jest.fn();
        renderHook(() => useOnChosenPhotosCleared(onCleared)).unmount();
        expect(() => announceChosenPhotosCleared()).not.toThrow();
        expect(onCleared).not.toHaveBeenCalled();
    });

    test('uses the callback of the latest render', () => {
        const first = jest.fn();
        const second = jest.fn();
        const { rerender } = renderHook(({ fn }) => useOnChosenPhotosCleared(fn), { initialProps: { fn: first } });
        rerender({ fn: second });
        announceChosenPhotosCleared();
        expect(first).not.toHaveBeenCalled();
        expect(second).toHaveBeenCalledTimes(1);
    });

    describe('a removal made elsewhere (the CLI, another window), seen in the settings-changed broadcast', () => {
        const after = (ms: number) => new Date(Date.now() + ms).toISOString();

        test('runs once when chosenPhotosClearedAt moves past the moment the editor mounted', () => {
            const onCleared = jest.fn();
            renderHook(() => useOnChosenPhotosCleared(onCleared));
            const stamp = after(1000);
            act(() => fireSettingsChanged({ chosenPhotosClearedAt: stamp }));
            expect(onCleared).toHaveBeenCalledTimes(1);
            // The same removal arrives in every later broadcast: it is announced once.
            act(() => fireSettingsChanged({ chosenPhotosClearedAt: stamp, theme: 'dark' }));
            expect(onCleared).toHaveBeenCalledTimes(1);
            // A later removal is a new one.
            act(() => fireSettingsChanged({ chosenPhotosClearedAt: after(5000) }));
            expect(onCleared).toHaveBeenCalledTimes(2);
        });

        test('a removal from before the editor opened is not news', () => {
            const onCleared = jest.fn();
            renderHook(() => useOnChosenPhotosCleared(onCleared));
            act(() => fireSettingsChanged({ chosenPhotosClearedAt: after(-60_000) }));
            expect(onCleared).not.toHaveBeenCalled();
        });

        test.each([
            ['no payload', undefined],
            ['a payload with no stamp', {}],
            ['a stamp that is not a string', { chosenPhotosClearedAt: 123 }],
            ['a stamp that is not a time', { chosenPhotosClearedAt: 'never' }],
            ['an empty stamp (never removed)', { chosenPhotosClearedAt: '' }],
        ])('%s is ignored', (_name, payload) => {
            const onCleared = jest.fn();
            renderHook(() => useOnChosenPhotosCleared(onCleared));
            act(() => fireSettingsChanged(payload));
            expect(onCleared).not.toHaveBeenCalled();
        });

        test('stops listening on unmount', () => {
            const onCleared = jest.fn();
            const { unmount } = renderHook(() => useOnChosenPhotosCleared(onCleared));
            unmount();
            act(() => fireSettingsChanged({ chosenPhotosClearedAt: after(1000) }));
            expect(onCleared).not.toHaveBeenCalled();
        });

        test('a host that has no settings-changed event just relies on the direct announcement', () => {
            const saved = mockApi.onSettingsChanged;
            mockApi.onSettingsChanged = invalid(undefined);
            try {
                const onCleared = jest.fn();
                renderHook(() => useOnChosenPhotosCleared(onCleared));
                announceChosenPhotosCleared();
                expect(onCleared).toHaveBeenCalledTimes(1);
            } finally {
                mockApi.onSettingsChanged = saved;
            }
        });
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
