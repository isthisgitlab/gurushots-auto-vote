import { useEffect, useState } from 'react';

import type { Challenge } from '../../types/gurushots';
import type { SwapBackRecord } from '../../types/stores';

/**
 * A slot whose recorded boosted/turbo'd original can be swapped back in.
 */
export type SwapBackOffer = Omit<SwapBackRecord, 'at'>;

/**
 * The challenge's swap-back offers: slots holding a replacement for a photo
 * that was swapped out (through this app) while boosted/turbo'd. Reads only the
 * main-side ledger.
 *
 * Keyed on one string — the challenge id plus its entry ids — so it refetches
 * exactly when a swap or swap back changes the slots, not on every render. The
 * effect reads the challenge id back out of that key, so the key is its only
 * dependency. A failed read is simply no offers.
 */
export function useSwapBacks(challenge: Challenge | null | undefined): SwapBackOffer[] {
    const [items, setItems] = useState<SwapBackOffer[]>([]);
    const entries = challenge?.member?.ranking?.entries;
    const entryKey = Array.isArray(entries) ? entries.map((e) => e?.id).join(',') : '';
    const requestKey = `${challenge?.id ?? ''}|${entryKey}`;

    useEffect(() => {
        const challengeId = requestKey.split('|')[0];
        if (!challengeId) return undefined;
        let cancelled = false;
        void (async () => {
            try {
                const res = await window.api.getSwapBacks(challengeId);
                if (!cancelled) setItems(res?.success && Array.isArray(res.items) ? res.items : []);
            } catch {
                if (!cancelled) setItems([]);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [requestKey]);

    return items;
}
