/**
 * useChallengeOverrides — the save guard behind a failed load: the form then
 * holds empty overrides, and saving them would wipe the challenge's stored
 * settings. The modal hides Save in that state; the hook refuses too.
 */

import { renderHook, act, waitFor } from '@testing-library/preact';
import { useChallengeOverrides } from '@/hooks/useChallengeOverrides';
import { mockApi } from './helpers/setup';

const props = () => ({
    isOpen: true,
    challengeId: '1',
    challengeTitle: 'Challenge 1',
    schema: { exposure: { type: 'number', default: 100, perChallenge: true } },
    defaults: { exposure: 70 },
    refetchSchema: jest.fn(),
    rearmSchedule: jest.fn().mockResolvedValue(undefined),
    onClose: jest.fn(),
});

beforeEach(() => {
    mockApi.getTitleProfile.mockReset().mockResolvedValue(null);
    mockApi.replaceChallengeOverrides.mockReset().mockResolvedValue(true);
    mockApi.logError.mockReset().mockResolvedValue(undefined);
});

test('save() writes nothing after a failed load', async () => {
    mockApi.getChallengeOverrides.mockReset().mockRejectedValue(new Error('ipc'));
    const p = props();
    const { result } = renderHook(() => useChallengeOverrides(p));
    await waitFor(() => expect(result.current.loadFailed).toBe(true));

    await act(() => result.current.save());

    expect(mockApi.replaceChallengeOverrides).not.toHaveBeenCalled();
    expect(p.onClose).not.toHaveBeenCalled();
});

test('a successful load clears the failure flag and saves normally', async () => {
    mockApi.getChallengeOverrides.mockReset().mockResolvedValue({ exposure: 50 });
    const p = props();
    const { result } = renderHook(() => useChallengeOverrides(p));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.loadFailed).toBe(false);

    await act(() => result.current.save());

    expect(mockApi.replaceChallengeOverrides).toHaveBeenCalledWith('1', { exposure: 50 }, false);
    expect(p.onClose).toHaveBeenCalled();
});
