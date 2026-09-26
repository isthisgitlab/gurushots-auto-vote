import { useRef } from 'react';

/**
 * A ref that always holds the value from the latest render. Lets an effect
 * keyed on something narrower than the value itself (a content fingerprint, or
 * mount only) read the current value without listing it as a dependency — the
 * value is typically a fresh object or callback identity every render, which
 * would re-run the effect each time. The returned ref is stable, so listing it
 * in a dependency array never re-triggers anything.
 *
 * @template T
 * @param {T} value
 * @returns {{ current: T }}
 */
export function useLatestRef(value) {
    const ref = useRef(value);
    ref.current = value;
    return ref;
}
