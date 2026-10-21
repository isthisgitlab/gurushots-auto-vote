/**
 * Restores keyboard focus when the button a press left focused unmounts (WCAG 2.4.3): without it,
 * focus drops to `body` and the keyboard user is lost.
 */

import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';

/** Focus is nowhere: on the page itself, or on an element that has just been removed. */
const focusIsLost = (): boolean => {
    const active = document.activeElement;
    return active === null || active === document.body || !active.isConnected;
};

/**
 * Returns the recorder for a press: call it with the pressed button (the click's `currentTarget`)
 * before the action. When the recorded button is later gone from the page while focus is lost —
 * on `body` (where a removed focused element drops it), on nothing, or on an element that is itself
 * being removed — focus moves to `fallback()`, evaluated at that moment, so it can name an element
 * only mounted then. Focus that has landed anywhere else is never moved. Focus that already sits on
 * `body` with nothing recorded moves nothing.
 *
 * The record is forgotten by a focusout from the button after which it no longer holds focus (while
 * it is still in the page) or by a focusin on any other element, so a press whose element stays
 * (a failed action) followed by the user moving on never acts later. A focusout from the button's
 * own removal (some engines fire one) is left to the layout effect, which has already run by the
 * time the deferred check sees the button gone. The record survives the window losing focus, and
 * focus can move without a focusout from the button (a dialog focusing its first button while the
 * window is unfocused): the focusin that follows when the window regains focus forgets the record,
 * and the layout effect moves focus only if it is actually lost. One ordering can still act: only
 * the two focus moves need to happen while the window is in the background (a silent move to
 * another element, then focus to `body`); when the window regains focus with `body` active no
 * element gets a focusin, so a later unmount — even in the foreground, while focus stays on `body`
 * — moves focus to the fallback.
 *
 * Some engines (WebKit, Firefox on macOS) do not focus a button on a mouse click: the recorder
 * records nothing then, and the unmount restores nothing.
 */
export function useFocusRestore(fallback: () => HTMLElement | null): (trigger: HTMLElement) => void {
    const triggerRef = useRef<HTMLElement | null>(null);

    useEffect(() => {
        const forgetOnBlur = (event: FocusEvent) => {
            const trigger = triggerRef.current;
            if (!trigger || event.target !== trigger) return;
            queueMicrotask(() => {
                // Still focused and in the page: the whole window lost focus, not just the button. A newer record
                // (another button) is not this microtask's to wipe — a race only script can produce (a focus() and
                // a click() in one task, as tests do): a microtask checkpoint follows every listener the browser
                // dispatches, so this microtask runs before any later click handler, and only a script-called
                // focus() keeps the stack busy.
                if (triggerRef.current === trigger && trigger.isConnected && document.activeElement !== trigger) {
                    triggerRef.current = null;
                }
            });
        };
        const forgetOnFocusElsewhere = (event: FocusEvent) => {
            if (triggerRef.current && event.target !== triggerRef.current) triggerRef.current = null;
        };
        document.addEventListener('focusout', forgetOnBlur);
        document.addEventListener('focusin', forgetOnFocusElsewhere);
        return () => {
            document.removeEventListener('focusout', forgetOnBlur);
            document.removeEventListener('focusin', forgetOnFocusElsewhere);
        };
    }, []);

    // The check runs after every render rather than after the action: the recorded element can
    // unmount well after the action resolved (a read that supersedes the action's own removes it).
    useLayoutEffect(() => {
        const trigger = triggerRef.current;
        if (!trigger || trigger.isConnected) return;
        triggerRef.current = null;
        if (focusIsLost()) fallback()?.focus({ preventScroll: true });
    });

    return useCallback((trigger: HTMLElement) => {
        triggerRef.current = document.activeElement === trigger ? trigger : null;
    }, []);
}
