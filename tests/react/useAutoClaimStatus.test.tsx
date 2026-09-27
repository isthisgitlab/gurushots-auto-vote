import { act, renderHook, waitFor } from '@testing-library/preact';
import { useAutoClaimStatus } from '@/api/useAutoClaimStatus';
import { invalid } from '../helpers/invalid';

test('refreshes the backend claim clock after scheduling changes and settings edits', async () => {
    let settingsChanged: () => void;
    const unsubscribe = jest.fn();
    window.api = invalid({
        getAutoClaimStatus: jest.fn().mockResolvedValue({ success: true, enabled: true, nextClaimAt: 0 }),
        onSettingsChanged: jest.fn((listener: () => void) => {
            settingsChanged = listener;
            return unsubscribe;
        }),
    });
    const { result, rerender, unmount } = renderHook(
        ({ nextRunAt, running }: { nextRunAt: number | null; running: boolean }) =>
            useAutoClaimStatus(nextRunAt, running),
        { initialProps: { nextRunAt: null as number | null, running: false } },
    );
    await waitFor(() => expect(result.current?.nextClaimAt).toBe(0));
    jest.mocked(window.api.getAutoClaimStatus).mockResolvedValue({
        success: true,
        enabled: true,
        nextClaimAt: 3_600_000,
    });
    rerender({ nextRunAt: 60_000, running: true });
    await waitFor(() => expect(result.current?.nextClaimAt).toBe(3_600_000));
    jest.mocked(window.api.getAutoClaimStatus).mockResolvedValue({
        success: true,
        enabled: false,
        nextClaimAt: 3_600_000,
    });
    await act(async () => settingsChanged());
    await waitFor(() => expect(result.current?.enabled).toBe(false));
    jest.mocked(window.api.getAutoClaimStatus).mockResolvedValue(invalid({ success: false }));
    rerender({ nextRunAt: null, running: false });
    await waitFor(() => expect(result.current).toBeNull());
    unmount();
    expect(unsubscribe).toHaveBeenCalled();
});
