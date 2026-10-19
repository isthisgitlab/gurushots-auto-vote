import { useCallback, useRef, useState } from 'react';

/**
 * Reports whether a remote image URL actually loads, so a caller can render
 * nothing instead of the browser's broken-image glyph.
 *
 * Listens for `error` on the rendered `<img>` itself, through the returned
 * callback ref and `addEventListener`: an `onError` prop is flagged by jsx-a11y
 * (it counts as an "interaction" on a non-interactive element, and the renderer
 * is linted with its rules, .oxlintrc.json), and a detached probe `Image` would
 * defeat `loading="lazy"` by fetching every image up front. The ref attaches in
 * the commit phase, before the browser dispatches `error` as a later task, so
 * no `complete` check is needed.
 *
 * Starts optimistic: a URL counts as loading until an error is seen for it, so
 * the image is not withheld on the happy path, and a test environment that
 * never fires `error` keeps rendering normally. The failed URL is stored, not a
 * flag: an error that arrives for a URL the `<img>` has since moved off cannot
 * condemn the current one.
 *
 * @param url - falsy short-circuits to `false`
 * @returns `[loads, imageRef]`: false once the URL is known to have failed, and
 *   the ref to put on the `<img>` that renders it
 */
export function useImageLoads(
    url: string | null | undefined,
): readonly [boolean, (img: HTMLImageElement | null) => void] {
    const [failedUrl, setFailedUrl] = useState<string | null>(null);
    const detach = useRef<(() => void) | null>(null);

    // A new URL gives a new ref, which React calls with null (detaching the old listener) and then
    // with the element again; an unmounted <img> calls it with null.
    const imageRef = useCallback(
        (img: HTMLImageElement | null) => {
            detach.current?.();
            detach.current = null;
            if (!img || !url) return;
            const onError = () => setFailedUrl(url);
            img.addEventListener('error', onError);
            detach.current = () => img.removeEventListener('error', onError);
        },
        [url],
    );

    return [!!url && failedUrl !== url, imageRef];
}
