import { useCallback, useState } from 'react';
import { useLatestRef } from './useLatestRef';

import type { OpenChallenge } from '../../types/gurushots';

type Price = { cost: number; list: OpenChallenge[] };

/**
 * The cost a join answered with when it was dearer than the row showed (`needs-confirm`): until the
 * list is read again, that is the row's cost, so the next confirmation shows (and names) it, not the
 * old one. `noteAnswer` records an answer; `withAnswerCost` gives a row its answered cost while the
 * list is the one the answer was given on.
 */
export function useRepricedRows(items: OpenChallenge[]) {
    const [repriced, setRepriced] = useState<Record<string, Price>>({});
    const listRead = useLatestRef(items);

    const noteAnswer = useCallback(
        (id: OpenChallenge['id'], answer: { status?: string; cost?: number } | null | undefined) => {
            if (answer?.status !== 'needs-confirm' || !Number.isFinite(Number(answer.cost))) return;
            setRepriced((prev) => ({ ...prev, [id]: { cost: Number(answer.cost), list: listRead.current } }));
        },
        [listRead],
    );

    const withAnswerCost = (row: OpenChallenge): OpenChallenge => {
        const price = repriced[String(row.id)];
        return price?.list === items ? { ...row, join_coins: price.cost } : row;
    };

    return { noteAnswer, withAnswerCost };
}
