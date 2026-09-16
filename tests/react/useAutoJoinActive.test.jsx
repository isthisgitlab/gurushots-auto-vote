/**
 * Tests for useAutoJoinActive — maps the IPC result to a boolean; anything but
 * an explicit success+active is treated as "not active" (badge off).
 */

import { renderHook, waitFor } from '@testing-library/preact';
import { useAutoJoinActive } from '@/api/useAutoJoinActive';

describe('useAutoJoinActive', () => {
    beforeEach(() => {
        window.api = { onSettingsChanged: undefined };
    });

    test('success + active:true → active true', async () => {
        window.api.getAutoJoinActive = jest.fn().mockResolvedValue({ success: true, active: true });
        const { result } = renderHook(() => useAutoJoinActive());
        await waitFor(() => expect(result.current.active).toBe(true));
    });

    test('success + active:false → active false', async () => {
        window.api.getAutoJoinActive = jest.fn().mockResolvedValue({ success: true, active: false });
        const { result } = renderHook(() => useAutoJoinActive());
        await waitFor(() => expect(window.api.getAutoJoinActive).toHaveBeenCalled());
        expect(result.current.active).toBe(false);
    });

    test('unsuccessful result → active false', async () => {
        window.api.getAutoJoinActive = jest.fn().mockResolvedValue({ success: false });
        const { result } = renderHook(() => useAutoJoinActive());
        await waitFor(() => expect(window.api.getAutoJoinActive).toHaveBeenCalled());
        expect(result.current.active).toBe(false);
    });
});
