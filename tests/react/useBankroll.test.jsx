/**
 * Tests for useBankroll — success maps to a flat balance; a failed read yields
 * null (NOT zeros), so the UI can show a "couldn't check" placeholder.
 */

import { renderHook, waitFor } from '@testing-library/preact';
import { useBankroll } from '@/api/useBankroll';

describe('useBankroll', () => {
    beforeEach(() => {
        window.api = { onSettingsChanged: undefined };
    });

    test('maps a successful read to the balance object', async () => {
        window.api.getBankroll = jest
            .fn()
            .mockResolvedValue({ success: true, keys: 8, swaps: 41, fills: 818, coins: 17540 });
        const { result } = renderHook(() => useBankroll());
        await waitFor(() => expect(result.current.loading).toBe(false));
        expect(result.current.bankroll).toEqual({ keys: 8, swaps: 41, fills: 818, coins: 17540 });
    });

    test('a failed read yields null, not zeros', async () => {
        window.api.getBankroll = jest.fn().mockResolvedValue({ success: false, error: 'nope' });
        const { result } = renderHook(() => useBankroll());
        await waitFor(() => expect(result.current.loading).toBe(false));
        expect(result.current.bankroll).toBeNull();
    });
});
