import { useLayoutEffect, useState } from 'react';

/**
 * Scrolls the modal body back to a panel the user just opened, when the body
 * is scrolled past that panel's top. Both settings modals call it from their
 * tab click handler — the user-selection path only: a `reveal` (a programmatic
 * selection, e.g. after a refused Save) changes the active tab without calling
 * it, so it never scrolls the modal, and a refetch moves the tab only through
 * the caller's derived fallback, which is such a `reveal`. Every ask scrolls —
 * including a repeat for the panel already shown, because the callers ignore a
 * click on the already-active tab, so a repeat id is always a real second ask.
 *
 * The request goes through one-shot state: the caller selects the tab and
 * asks in the same event, and the effect consumes the request after the render
 * that shows the panel — measuring while the panel is still hidden would read
 * a top of 0. The sticky chrome above the panel (filter bar, tab row), which
 * the panel top must clear, is measured off `stickyRef` at scroll time; a
 * height change on its own (a banner toggling in or out) never re-runs it.
 */
export function useScrollPanelIntoView(
    bodyRef: { readonly current: HTMLElement | null },
    stickyRef: { readonly current: HTMLElement | null },
): (panelId: string) => void {
    const [pending, setPending] = useState<{ id: string } | null>(null);

    const requestScroll = (panelId: string) => {
        // A fresh object per request, so asking for the same id twice schedules a second run.
        setPending({ id: panelId });
    };

    useLayoutEffect(() => {
        if (pending === null) return;
        setPending(null); // the request is one-shot: consumed by the run after its render
        const body = bodyRef.current;
        const panel = document.getElementById(pending.id);
        if (!body || !panel) return;
        const stickyHeight = stickyRef.current?.offsetHeight ?? 0;
        // The panel's top in the body's scrollable content, minus the chrome it must clear.
        const target =
            panel.getBoundingClientRect().top - body.getBoundingClientRect().top + body.scrollTop - stickyHeight;
        // Only a body scrolled past the panel top moves; a panel already in view (or below it) stays.
        if (body.scrollTop <= target) return;
        body.scrollTop = target;
    }, [bodyRef, pending, stickyRef]);

    return requestScroll;
}
