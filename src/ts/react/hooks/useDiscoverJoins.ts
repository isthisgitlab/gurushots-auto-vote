import { useCallback, useEffect, useState } from 'react';
import * as ipc from '@/api/ipc';
import { useLatestRef } from './useLatestRef';
import { useRepricedRows } from './useRepricedRows';
import { costOf, rowToConfirm } from '../utils/discoverCost';
import { errorMessage } from '../../errorMessage';

import type { JoinOutcome } from '@/components/app/DiscoverSection';
import type { OpenChallenge } from '../../types/gurushots';

/** What a row's join is doing: asking what it costs (nothing is spent), or joining. */
export type JoinPhase = 'asking' | 'joining';

/**
 * The joins of the Discover rows: what each is doing, what it answered, the paid join waiting for
 * the user's confirmation, and the cost the last answer named.
 *
 * Every Join (and "Retry submit") first ASKS, without spending: a paid challenge whose coins were
 * already spent is submitted by the server at once, one still to be paid answers with its cost, and
 * only then is the price confirmed (`confirm`) and a real, consented join sent (`onConfirm`).
 *
 * @param isLoggedIn - a different account (a logout and login) sees none of the previous one's state
 */
export function useDiscoverJoins({
    items,
    isLoggedIn,
    refetch,
    onJoined,
}: {
    items: OpenChallenge[];
    isLoggedIn: boolean;
    refetch: () => Promise<void>;
    onJoined: () => void;
}) {
    const [confirm, setConfirm] = useState<OpenChallenge | null>(null);
    const [busy, setBusy] = useState<ReadonlyMap<OpenChallenge['id'], JoinPhase>>(new Map());
    const [results, setResults] = useState<Record<string, JoinOutcome>>({});
    const { noteAnswer, withAnswerCost } = useRepricedRows(items);
    const confirmOpen = useLatestRef(confirm);

    useEffect(() => {
        setResults({});
        setConfirm(null);
        setBusy(new Map());
    }, [isLoggedIn]);

    const join = useCallback(
        async (challenge: OpenChallenge, spendCoins: boolean) => {
            const id = challenge.id;
            const phase: JoinPhase = spendCoins || costOf(challenge) <= 0 ? 'joining' : 'asking';
            setBusy((prev) => new Map(prev).set(id, phase));
            try {
                // A paid join names the cost the user was shown: a price that rose since then is not consented to.
                const res: JoinOutcome = spendCoins
                    ? await ipc.joinChallenge(id, true, costOf(challenge))
                    : await ipc.joinChallenge(id, false);
                const toConfirm = rowToConfirm(challenge, spendCoins, res);
                if (toConfirm) {
                    // A confirmation already open stays as it is: another row's answer must not swap what it asks
                    // the user to pay for, and that answer is dropped, its row untouched.
                    if (confirmOpen.current) return;
                    noteAnswer(id, res);
                    setConfirm((prev) => prev ?? toConfirm);
                    // Nothing yet to say about this row: an earlier outcome line would contradict the dialog.
                    setResults((prev) =>
                        Object.fromEntries(Object.entries(prev).filter(([key]) => key !== String(id))),
                    );
                    return;
                }
                noteAnswer(id, res);
                setResults((prev) => ({ ...prev, [id]: res }));
                // Refetch on any outcome that changes what's joinable (joined, coins charged, the
                // challenge is gone, or its price moved) so a stale row/button doesn't linger.
                if (
                    res.success ||
                    ['charged-pending-submit', 'unavailable', 'needs-confirm'].includes(res.status ?? '')
                ) {
                    void refetch();
                }
                if (res.success || res.status === 'charged-pending-submit') onJoined();
            } catch (err) {
                setResults((prev) => ({ ...prev, [id]: { status: 'failed-no-charge', error: errorMessage(err) } }));
            } finally {
                setBusy((prev) => {
                    const next = new Map(prev);
                    next.delete(id);
                    return next;
                });
            }
        },
        [refetch, onJoined, noteAnswer, confirmOpen],
    );

    const ask = useCallback((challenge: OpenChallenge) => void join(challenge, false), [join]);

    const onConfirm = useCallback(async () => {
        const challenge = confirm;
        setConfirm(null);
        // The modal's Spend button renders only while a challenge is pending; nothing pending, nothing to spend on.
        if (challenge) await join(challenge, true);
    }, [confirm, join]);

    const dismiss = useCallback(() => setConfirm(null), []);

    return { confirm, results, busy, withAnswerCost, ask, onConfirm, dismiss };
}
