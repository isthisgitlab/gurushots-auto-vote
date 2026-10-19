import { useCallback, useEffect, useRef, useState } from 'react';
import * as ipc from '@/api/ipc';
import { useLatestRef } from './useLatestRef';
import { useRepricedRows } from './useRepricedRows';
import { costOf, rowToConfirm } from '../utils/discoverCost';
import { errorMessage } from '../../errorMessage';

import type { JoinOutcome } from '@/components/app/DiscoverSection';
import type { OpenChallenge } from '../../types/gurushots';

/** What a row's join is doing: asking what it costs (nothing is spent), or joining. */
export type JoinPhase = 'asking' | 'joining';

// An answer that changes what's joinable: joined, coins charged, the challenge is gone, or its price moved.
const changesRows = (res: JoinOutcome) =>
    res.success || ['charged-pending-submit', 'unavailable', 'needs-confirm'].includes(res.status ?? '');

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
    const resultsNow = useLatestRef(results);
    // Counts the sessions (a logout and login): an answer to a join begun in an earlier one is dropped.
    const session = useRef(0);

    useEffect(() => {
        session.current += 1;
        setResults({});
        setConfirm(null);
        setBusy(new Map());
    }, [isLoggedIn]);

    const join = useCallback(
        async (challenge: OpenChallenge, spendCoins: boolean) => {
            const id = challenge.id;
            // A row whose coins are already spent is being submitted, not asked about.
            const submitting = resultsNow.current[String(id)]?.status === 'charged-pending-submit';
            const phase: JoinPhase = spendCoins || submitting || costOf(challenge) <= 0 ? 'joining' : 'asking';
            const started = session.current;
            setBusy((prev) => new Map(prev).set(id, phase));
            try {
                // A paid join names the cost the user was shown: a price that rose since then is not consented to.
                const res: JoinOutcome = spendCoins
                    ? await ipc.joinChallenge(id, true, costOf(challenge))
                    : await ipc.joinChallenge(id, false);
                // The account changed meanwhile: this answer is not the new account's to see.
                if (session.current !== started) return;
                const toConfirm = rowToConfirm(challenge, spendCoins, res);
                if (toConfirm) {
                    // A confirmation already open stays as it is: another row's answer must not swap what it asks
                    // the user to pay for. The answer is dropped (no repricing); its row says to try again.
                    if (confirmOpen.current) {
                        setResults((prev) => ({ ...prev, [id]: { status: 'confirm-dialog-open' } }));
                        return;
                    }
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
                if (changesRows(res)) void refetch();
                if (res.success || res.status === 'charged-pending-submit') onJoined();
            } catch (err) {
                if (session.current !== started) return;
                setResults((prev) => ({ ...prev, [id]: { status: 'failed-no-charge', error: errorMessage(err) } }));
            } finally {
                // (A session that ended already reset the busy rows; the new one's joins are not this one's to clear.)
                if (session.current === started) {
                    setBusy((prev) => {
                        const next = new Map(prev);
                        next.delete(id);
                        return next;
                    });
                }
            }
        },
        [refetch, onJoined, noteAnswer, confirmOpen, resultsNow],
    );

    const ask = useCallback((challenge: OpenChallenge) => void join(challenge, false), [join]);

    const onConfirm = useCallback(async () => {
        const challenge = confirm;
        setConfirm(null);
        // The modal's Spend button renders only while a challenge is pending; nothing pending, nothing to spend on.
        if (challenge) await join(challenge, true);
    }, [confirm, join]);

    const dismiss = useCallback(() => setConfirm(null), []);

    // A row's outcome line goes when its payment is forgotten: the next Join starts over and asks the price.
    const clearResult = useCallback(
        (id: OpenChallenge['id']) =>
            setResults((prev) => Object.fromEntries(Object.entries(prev).filter(([key]) => key !== String(id)))),
        [],
    );

    return { confirm, results, busy, withAnswerCost, ask, onConfirm, dismiss, clearResult };
}
