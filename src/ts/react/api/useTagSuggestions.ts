import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { useIpcQuery } from './useIpcQuery';
import { logRendererError } from './ipc';
import { MIN_AUTOCOMPLETE_CHARS } from '../../settings/limits';

import type { WindowApi } from '../../types/ipc';
import type { IpcQueryApply } from './useIpcQuery';

/** The search-photo-tags reply, as the handler answers it. */
type SearchTagsResult = Awaited<ReturnType<WindowApi['searchPhotoTags']>>;

/** What the hook shows: the current reply's tags, and whether what is shown IS a reply. */
interface TagSuggestions {
    tags: Array<string>;
    replied: boolean;
}

const NO_SUGGESTIONS: TagSuggestions = { tags: [], replied: false };

// The debounce: one autocomplete request once the typing pauses, not one per keystroke.
const DEBOUNCE_MS = 300;

const searchTagsIpc = (term: string) => window.api.searchPhotoTags(term);

/**
 * The reply sorted into what the hook can show: the tags, or why nothing can be.
 * A reply that is not the success/failure envelope (a host bridge answering
 * anything else) reads as a failure too.
 */
const replyOf = (result: SearchTagsResult): { ok: true; tags: Array<string> } | { ok: false; reason: string } => {
    if (typeof result !== 'object' || result === null) return { ok: false, reason: 'reply was not an object' };
    if (!result.success) return { ok: false, reason: result.error };
    return { ok: true, tags: result.tags };
};

/**
 * The library's tags that contain the typed term, for the picker's search box: after a
 * 300 ms debounce the term goes to search-photo-tags, and the tags it answers are shown
 * as one-click exact searches.
 *
 * Only a reply for the CURRENT term is ever applied — the term is kept trimmed in a ref,
 * the refetch gets that same value, and a reply whose term no longer matches is dropped
 * (failure replies included), which closes the gap `latestOnly` alone leaves: "flo" in
 * flight while the user backspaces to "fl". A superseded reply is normal flow and is
 * silently ignored; any other failure, or a reply that is not the envelope, shows no
 * suggestions and is logged once per mount, with the reason only — never the typed term.
 *
 * @param term - the search box's text as typed; trimmed here
 * @returns `tags` — the current reply's tags, empty while none apply; `replied` —
 *   whether `tags` is what a current reply answered (not the per-keystroke clear)
 */
export function useTagSuggestions(term: string) {
    // The latest typed term, trimmed; null once unmounted, so a late reply is dropped.
    const currentTerm = useRef<string | null>(null);
    // The failure log is written at most once per mount.
    const loggedRef = useRef(false);

    const apply: IpcQueryApply<SearchTagsResult, TagSuggestions, Error, [string]> = useCallback(
        (result, { setData }, replyTerm) => {
            if (replyTerm !== currentTerm.current) return;
            const reply = replyOf(result);
            if (!reply.ok) {
                if (reply.reason === 'superseded') return;
                if (!loggedRef.current) {
                    loggedRef.current = true;
                    void logRendererError(`Tag suggestions unavailable (${reply.reason})`);
                }
                setData({ tags: [], replied: true });
                return;
            }
            setData({ tags: reply.tags, replied: true });
        },
        [],
    );

    const { data, setData, refetch } = useIpcQuery(searchTagsIpc, {
        latestOnly: true,
        enabled: false,
        initialData: NO_SUGGESTIONS,
        apply,
    });

    useLayoutEffect(() => {
        const trimmed = term.trim();
        currentTerm.current = trimmed;
        // The shown tags clear at once, so an old suggestion is never clickable.
        setData(NO_SUGGESTIONS);
        // Under the server's own minimum the endpoint answers nothing at all, so no request.
        if (trimmed.length < MIN_AUTOCOMPLETE_CHARS) return undefined;
        const timer = setTimeout(() => {
            void refetch(trimmed);
        }, DEBOUNCE_MS);
        return () => clearTimeout(timer);
    }, [term, refetch, setData]);

    useEffect(
        () => () => {
            currentTerm.current = null;
        },
        [],
    );

    return { tags: data.tags, replied: data.replied };
}
