import { useId, useLayoutEffect, useRef } from 'react';

/**
 * Where the keyboard lands after a list changes. A focused button that is removed, or turned off because a list is
 * full, drops the focus to the page; these helpers move it on once the change is on screen.
 *
 *   - after an add: the first control of the new row;
 *   - after a remove: the remove button now in that row's place, else the previous row's, else the list's add control.
 */

type Find = () => HTMLElement | null | undefined;

/** The marks a list's rows and buttons carry; every list instance has its own id, so lists nest and repeat freely. */
type ListMarks = Readonly<Record<string, string>>;

export interface ListFocus {
    /** Spread on each row's own element. */
    row: ListMarks;
    /** Spread on each row's remove button. */
    remove: ListMarks;
    /** Spread on the add control. */
    add: ListMarks;
    /** Call as a row is added; `count` is the number of rows before it. */
    afterAdd: (count: number) => void;
    /** Call as the row at `index` is removed. */
    afterRemove: (index: number) => void;
}

const CONTROLS = 'input, select, textarea, button';

/** A control that can take the focus (a turned-off one cannot). */
const usable = (element: HTMLElement | null | undefined): HTMLElement | null =>
    element && !element.hasAttribute('disabled') ? element : null;

/** The first control inside `container`, or null when there is no container (a row that is not on screen). */
export const firstControl = (container: Element | null | undefined): HTMLElement | null =>
    container ? (container.querySelector<HTMLElement>(CONTROLS) as HTMLElement | null) : null;

/**
 * Focus what `find` answers once the render that follows the call is on screen. Call `request` from the event handler
 * that changes the list, in the component that stays mounted through the change.
 */
export function useFocusAfterRender(): (find: Find) => void {
    const pending = useRef<Find | null>(null);
    useLayoutEffect(() => {
        const find = pending.current;
        pending.current = null;
        find?.()?.focus();
    });
    return (find) => {
        pending.current = find;
    };
}

const marked = (kind: 'row' | 'remove' | 'add', id: string): HTMLElement[] =>
    Array.from(document.querySelectorAll<HTMLElement>(`[data-list-${kind}="${id}"]`));

/**
 * The focus rule for one list of rows with their remove buttons and an add control.
 */
export function useListFocus(): ListFocus {
    const id = useId();
    const request = useFocusAfterRender();
    return {
        row: { 'data-list-row': id },
        remove: { 'data-list-remove': id },
        add: { 'data-list-add': id },
        afterAdd: (count) => request(() => firstControl(marked('row', id)[count])),
        afterRemove: (index) =>
            request(() => {
                const removes = marked('remove', id);
                return usable(removes[index]) ?? usable(removes[index - 1]) ?? usable(marked('add', id)[0]);
            }),
    };
}
