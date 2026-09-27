/**
 * useSessionLoad — the modal load-on-open behind useTitleRules and
 * useChallengeOverrides: a failure is flagged and logged once, even when the
 * load rejects without a reason, and a successful load hands its value over.
 */

import { renderHook, waitFor } from '@testing-library/preact';
import { useSessionLoad } from '@/hooks/useSessionLoad';
import { mockApi } from './helpers/setup';

beforeEach(() => {
    mockApi.logError.mockReset().mockResolvedValue(undefined);
});

test('a successful load hands its value to onLoad', async () => {
    const load = jest.fn().mockResolvedValue('value');
    const onLoad = jest.fn();
    const { result } = renderHook(() => useSessionLoad(load, { enabled: true, onLoad, failureLog: 'Error x' }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(onLoad).toHaveBeenCalledWith('value');
    expect(result.current.loadFailed).toBe(false);
});

test('a load rejected without a reason still counts as failed', async () => {
    const load = jest.fn().mockRejectedValue(undefined);
    const onLoad = jest.fn();
    const { result } = renderHook(() => useSessionLoad(load, { enabled: true, onLoad, failureLog: 'Error x' }));
    await waitFor(() => expect(result.current.loadFailed).toBe(true));
    expect(mockApi.logError).toHaveBeenCalledWith('Error x: undefined');
    expect(onLoad).not.toHaveBeenCalled();
});
