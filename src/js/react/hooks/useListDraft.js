import { useEffect, useState } from 'react';
import { useLatestRef } from '@/hooks/useLatestRef';

// Used only to fingerprint a list value for the draft sync below. A comma is
// fine here: tag input is split on commas before storage, so a stored tag can
// never itself contain one, and the time lists hold "HH:MM" strings or integer
// seconds — a collision-free separator for all three. Compare with '' (empty
// string) which would treat ['ab','c'] and ['a','bc'] as identical.
export const LIST_FINGERPRINT_SEP = ',';

/**
 * Local draft for a list-valued setting. The draft re-syncs from `value` only
 * when the stored list's fingerprint changes AND the draft doesn't already
 * emit it, so an edit never gets overwritten by its own round-trip through
 * onChange, while an external replace (reset button, reload) does land.
 *
 * `toDraft(value)` builds the draft and `draftKeyOf(draft)` fingerprints what
 * the draft would emit; both must be module-level (stable) functions. The
 * value is read through a ref because it is a fresh array every render — the
 * fingerprint, not its identity, is what should re-trigger the sync.
 */
export function useListDraft(value, toDraft, draftKeyOf) {
    const [draft, setDraft] = useState(() => toDraft(value));
    const valueRef = useLatestRef(value);
    const valueKey = value.join(LIST_FINGERPRINT_SEP);
    useEffect(() => {
        setDraft((current) => (draftKeyOf(current) === valueKey ? current : toDraft(valueRef.current)));
    }, [valueKey, valueRef, toDraft, draftKeyOf]);
    return [draft, setDraft];
}
