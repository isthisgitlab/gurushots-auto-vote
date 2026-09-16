import { useEffect, useState } from 'react';

/**
 * Reports whether a remote image URL actually loads, so a caller can render
 * nothing instead of the browser's broken-image glyph.
 *
 * Probes with a detached `Image` rather than an `onError` prop on the rendered
 * `<img>`: jsx-a11y counts `onError` among "interactions" on a non-interactive
 * element, and this repo runs that rule set as a shrinking backlog (see the
 * jsx-a11y block in eslint.config.mjs), so the handler would add a warning. The
 * probe shares the browser HTTP cache with the `<img>` that renders the same
 * URL, so it costs no extra network round trip.
 *
 * Starts optimistic — `true` until a failure is observed — so the image is not
 * withheld for a round trip on the happy path, and so a test environment that
 * never fires either callback keeps rendering normally.
 *
 * @param {string|null|undefined} url - falsy short-circuits to `false`
 * @returns {boolean} false once the URL is known to have failed
 */
export function useImageLoads(url) {
    const [failed, setFailed] = useState(false);

    useEffect(() => {
        if (!url) return undefined;
        // A previous url's failure must not condemn this one.
        setFailed(false);
        let cancelled = false;
        const probe = new Image();
        probe.onerror = () => {
            if (!cancelled) setFailed(true);
        };
        probe.src = url;
        return () => {
            cancelled = true;
        };
    }, [url]);

    return !!url && !failed;
}
