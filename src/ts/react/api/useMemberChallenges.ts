import { useIpcResultQuery } from './useIpcQuery';

import type { OpenChallenge } from '../../types/gurushots';

const fetchMemberChallenges = () => window.api.getMemberChallenges();
const selectItems = (result: { items: OpenChallenge[] }): OpenChallenge[] =>
    Array.isArray(result.items) ? result.items : [];
const fetchFailed = (result: { error?: string } | null | undefined): { data: OpenChallenge[]; error: Error } => ({
    data: [],
    error: new Error(result?.error || 'fetch_failed'),
});

/**
 * Fetches the list of un-joined ("open") challenges the member can join, via
 * IPC. Token resolved server-side. `items` is always an array; each carries what
 * the Chosen Photos settings say for it (its own list and how many photos apply).
 */
export function useMemberChallenges(): {
    items: OpenChallenge[];
    loading: boolean;
    error: Error | null;
    refetch: () => Promise<void>;
} {
    const { data, loading, error, refetch } = useIpcResultQuery(fetchMemberChallenges, {
        initialData: [] as OpenChallenge[],
        select: selectItems,
        fail: fetchFailed,
    });
    return { items: data, loading, error, refetch };
}
