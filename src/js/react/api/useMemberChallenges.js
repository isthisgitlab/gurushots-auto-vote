import { useIpcResultQuery } from './useIpcQuery';

const fetchMemberChallenges = () => window.api.getMemberChallenges();
const selectItems = (result) => (Array.isArray(result.items) ? result.items : []);
const fetchFailed = (result) => ({ data: [], error: new Error(result?.error || 'fetch_failed') });

/**
 * Fetches the list of un-joined ("open") challenges the member can join, via
 * IPC. Token resolved server-side. `items` is always an array.
 *
 * @returns {{ items: Array<object>, loading: boolean, error: Error|null, refetch: function }}
 */
export function useMemberChallenges() {
    const { data, loading, error, refetch } = useIpcResultQuery(fetchMemberChallenges, {
        initialData: [],
        select: selectItems,
        fail: fetchFailed,
    });
    return { items: data, loading, error, refetch };
}
