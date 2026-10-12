import { useEffect, useState } from 'react';
import * as ipc from './ipc';

/**
 * The coin balance as GuruShots reports it now, read once each time `active` turns on (null while unread, and when
 * it could not be read). It is only shown, beside a balance recorded earlier: nothing decides on it.
 *
 * @param active - whether the balance is wanted (a dialog that shows it is open)
 */
export function useCoinsNow(active: boolean): number | null {
    const [coins, setCoins] = useState<number | null>(null);

    useEffect(() => {
        setCoins(null);
        if (!active) return undefined;
        let cancelled = false;
        void ipc
            .callOrNull(() => window.api.getBankroll())
            .then((bankroll) => {
                const read = bankroll?.success ? Number(bankroll.coins) : Number.NaN;
                if (!cancelled) setCoins(Number.isFinite(read) ? read : null);
            });
        return () => {
            cancelled = true;
        };
    }, [active]);

    return coins;
}
