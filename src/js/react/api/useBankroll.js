import { useIpcResultQuery } from './useIpcQuery';

/** @import { Bankroll } from '../../types/gurushots' */

const fetchBankroll = () => window.api.getBankroll();
/**
 * @param {Bankroll} result
 * @returns {Bankroll}
 */
const selectBalances = (result) => ({
    keys: result.keys,
    swaps: result.swaps,
    fills: result.fills,
    coins: result.coins,
});
// null (not 0) so the UI shows a "couldn't check" placeholder rather than
// implying an empty balance.
/** @returns {{ data: null }} */
const noBalances = () => ({ data: null });

/**
 * Fetches the account bankroll (keys/swaps/fills/coins) via IPC. The token is
 * resolved server-side by the handler, so no argument is threaded here.
 *
 * A normal query — NOT a signal: the balance changes rarely (only after a
 * vote/join/turbo/fill), so there is no per-second tick to optimize. `bankroll`
 * is the balances object, or null when the balance could not be read (transport
 * failure) — callers must render a placeholder (never 0) in that case.
 *
 * @returns {{ bankroll: Bankroll | null, loading: boolean, error: Error|null, refetch: () => Promise<void> }}
 */
export function useBankroll() {
    const { data, loading, error, refetch } = useIpcResultQuery(fetchBankroll, {
        select: selectBalances,
        fail: noBalances,
    });
    return { bankroll: data, loading, error, refetch };
}
