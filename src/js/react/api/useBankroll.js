import { useCallback } from 'react';
import { useIpcQuery } from './useIpcQuery';

/**
 * Fetches the account bankroll (keys/swaps/fills/coins) via IPC. The token is
 * resolved server-side by the handler, so no argument is threaded here.
 *
 * A normal query — NOT a signal: the balance changes rarely (only after a
 * vote/join/turbo/fill), so there is no per-second tick to optimize. `bankroll`
 * is the balances object, or null when the balance could not be read (transport
 * failure) — callers must render a placeholder (never 0) in that case.
 *
 * @returns {{ bankroll: {keys:number,swaps:number,fills:number,coins:number}|null,
 *   loading: boolean, error: Error|null, refetch: function }}
 */
export function useBankroll() {
    const queryFn = useCallback(() => window.api.getBankroll(), []);

    const apply = useCallback((result, { setData, setError }) => {
        if (result?.success) {
            setData({ keys: result.keys, swaps: result.swaps, fills: result.fills, coins: result.coins });
            setError(null);
            return;
        }
        // null (not 0) so the UI shows a "couldn't check" placeholder rather than
        // implying an empty balance.
        setData(null);
    }, []);

    const { data, loading, error, refetch } = useIpcQuery(queryFn, { initialData: null, apply });
    return { bankroll: data, loading, error, refetch };
}
