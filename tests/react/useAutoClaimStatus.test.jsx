import { act, renderHook, waitFor } from '@testing-library/preact';
import { useAutoClaimStatus } from '@/api/useAutoClaimStatus';

test('refreshes the backend claim clock after scheduling changes and settings edits', async () => {
    let settingsChanged;
    const unsubscribe = jest.fn();
    window.api = {
        getAutoClaimStatus: jest.fn().mockResolvedValue({ success: true, enabled: true, nextClaimAt: 0 }),
        onSettingsChanged: jest.fn((listener) => {
            settingsChanged = listener;
            return unsubscribe;
        }),
    };
    const { result, rerender, unmount } = renderHook(
        ({ nextRunAt, running }) => useAutoClaimStatus(nextRunAt, running),
        { initialProps: { nextRunAt: null, running: false } },
    );
    await waitFor(() => expect(result.current?.nextClaimAt).toBe(0));
    window.api.getAutoClaimStatus.mockResolvedValue({ success: true, enabled: true, nextClaimAt: 3_600_000 });
    rerender({ nextRunAt: 60_000, running: true });
    await waitFor(() => expect(result.current?.nextClaimAt).toBe(3_600_000));
    window.api.getAutoClaimStatus.mockResolvedValue({ success: true, enabled: false, nextClaimAt: 3_600_000 });
    await act(async () => settingsChanged());
    await waitFor(() => expect(result.current?.enabled).toBe(false));
    window.api.getAutoClaimStatus.mockResolvedValue({ success: false });
    rerender({ nextRunAt: null, running: false });
    await waitFor(() => expect(result.current).toBeNull());
    unmount();
    expect(unsubscribe).toHaveBeenCalled();
});
