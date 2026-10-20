/**
 * usePhotoPicker at the hook level: the one invariant no component can reach — Auto never ranks,
 * whatever asks it to, without a challenge to rank for. The other Auto gate (a Discover row's
 * not-joined challenge) lives in the toolbar, tested at the component level in
 * PhotoChooserModal.test.tsx.
 */

import { act, renderHook, waitFor } from '@testing-library/preact';
import { usePhotoPicker } from '@/hooks/usePhotoPicker';
import { mockApi } from './helpers/setup';

test('a ranking asked for with no challenge to rank for is refused at the door', async () => {
    const { result } = renderHook(() =>
        usePhotoPicker({ challengeId: null, usage: 'submit', alwaysFresh: false, selected: [] }),
    );
    await act(async () => result.current.autoSuggest());
    expect(mockApi.suggestPhotos).not.toHaveBeenCalled();
    expect(result.current.suggested).toBeNull();
});

test('forgetIdle drops what the idle grid was keeping in place, beside a selection replaced wholesale', async () => {
    const { result, rerender } = renderHook(
        (props: { selected: string[] }) =>
            usePhotoPicker({ challengeId: 7, usage: 'submit', alwaysFresh: false, ...props }),
        { initialProps: { selected: ['a'] } },
    );
    await waitFor(() => expect(result.current.idleShown).toEqual(['a']));
    // The other-account reset: the selection goes empty and the kept tiles go with it.
    rerender({ selected: [] });
    act(() => result.current.forgetIdle());
    expect(result.current.idleShown).toEqual([]);
});
