/**
 * useDiscoverJoins — what confirming does when nothing is waiting for confirmation.
 */

import { renderHook, act } from '@testing-library/preact';
import { useDiscoverJoins } from '@/hooks/useDiscoverJoins';
import { mockApi } from './helpers/setup';

test('confirming with nothing pending spends nothing: no join is sent, and nothing is left busy or answered', async () => {
    const refetch = jest.fn<Promise<void>, []>().mockResolvedValue(undefined);
    const onJoined = jest.fn<void, []>();
    const { result } = renderHook(() => useDiscoverJoins({ items: [], refetch, onJoined }));
    expect(result.current.confirm).toBeNull();

    await act(() => result.current.onConfirm());

    expect(mockApi.joinChallenge).not.toHaveBeenCalled();
    expect(result.current.confirm).toBeNull();
    expect(result.current.results).toEqual({});
    expect(result.current.busy.size).toBe(0);
    expect(refetch).not.toHaveBeenCalled();
    expect(onJoined).not.toHaveBeenCalled();
});
