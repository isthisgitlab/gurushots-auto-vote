import { useCallback } from 'react';
import { useIpcQuery } from './useIpcQuery';

import type { OpenChallenge } from '../../types/gurushots';
import type { IpcQueryTools } from './useIpcQuery';

type MemberChallengesResult = Awaited<ReturnType<typeof window.api.getMemberChallenges>>;

const fetchMemberChallenges = () => window.api.getMemberChallenges();

/**
 * Fetches the list of un-joined ("open") challenges the member can join, via
 * IPC. Token resolved server-side. `items` is always an array; each carries what
 * the Chosen Photos settings say for it (its own list and how many photos apply).
 *
 * A failed read (the server's error, a missing answer, a rejection) sets `error` and leaves `items`
 * as the last good read had them, so the rows on screen — a paid join waiting for its Retry submit
 * among them — survive an automatic re-read that fails.
 */
export function useMemberChallenges(): {
    items: OpenChallenge[];
    loading: boolean;
    error: Error | null;
    refetch: () => Promise<void>;
} {
    const apply = useCallback(
        (result: MemberChallengesResult, { setData, setError }: IpcQueryTools<OpenChallenge[], Error>) => {
            if (result?.success) {
                setData(Array.isArray(result.items) ? result.items : []);
                setError(null);
            } else {
                setError(new Error(result?.error || 'fetch_failed'));
            }
        },
        [],
    );
    const { data, loading, error, refetch } = useIpcQuery(fetchMemberChallenges, {
        initialData: [] as OpenChallenge[],
        apply,
    });
    return { items: data, loading, error, refetch };
}
