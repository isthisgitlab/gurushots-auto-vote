import { useIpcResultQuery } from './useIpcQuery';

/** @import { Challenge } from '../../types/gurushots' */

const fetchMemberChallenges = () => window.api.getMemberChallenges();
/**
 * @param {{ items: Challenge[] }} result
 * @returns {Challenge[]}
 */
const selectItems = (result) => (Array.isArray(result.items) ? result.items : []);
/**
 * @param {{ error?: string } | null | undefined} result
 * @returns {{ data: Challenge[], error: Error }}
 */
const fetchFailed = (result) => ({ data: [], error: new Error(result?.error || 'fetch_failed') });

/**
 * Fetches the list of un-joined ("open") challenges the member can join, via
 * IPC. Token resolved server-side. `items` is always an array.
 *
 * @returns {{ items: Challenge[], loading: boolean, error: Error|null, refetch: () => Promise<void> }}
 */
export function useMemberChallenges() {
    const { data, loading, error, refetch } = useIpcResultQuery(fetchMemberChallenges, {
        initialData: /** @type {Challenge[]} */ ([]),
        select: selectItems,
        fail: fetchFailed,
    });
    return { items: data, loading, error, refetch };
}
