import { useId, useState } from 'react';

import type { ComponentChildren } from 'preact';
import type { TargetedFocusEvent, TargetedKeyboardEvent } from 'preact';

// DaisyUI's focus dropdown closes on blur, so Escape just drops focus. Attached to the wrapper, so it sees keys from
// the trigger and every entry button inside.
const blurOnEscape = (e: TargetedKeyboardEvent<HTMLElement>) => {
    if (e.key === 'Escape') (e.target as HTMLElement).blur();
};

/**
 * A DaisyUI dropdown whose trigger is a real `<button>` (focusable, Enter and Space work) that discloses the list
 * (`aria-expanded`, `aria-controls`). The list is plain buttons, not an ARIA menu, so the trigger does not claim
 * `aria-haspopup` (its default, "menu", would misannounce it). Opening is CSS-driven by focus within the wrapper;
 * `aria-expanded` follows the same focus so assistive tech hears the state. The menu closes on Escape and when
 * focus leaves.
 *
 * @param props.trigger - the trigger button's content
 * @param props.triggerClassName - DaisyUI classes of the trigger button
 * @param props.describedBy - id of an element describing the menu, set on the trigger
 * @param props.className - extra wrapper classes (placement, e.g. `dropdown-end`)
 * @param props.menuClassName - classes of the menu list
 * @param props.children - the menu's `<li>` items
 */
export function FocusDropdown({
    trigger,
    triggerClassName,
    describedBy,
    className = '',
    menuClassName,
    children,
}: {
    trigger: ComponentChildren;
    triggerClassName: string;
    describedBy?: string;
    className?: string;
    menuClassName: string;
    children: ComponentChildren;
}) {
    const [open, setOpen] = useState(false);
    const menuId = useId();
    const handleFocusOut = (e: TargetedFocusEvent<HTMLElement>) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false);
    };
    return (
        <div
            className={`dropdown ${className}`.trim()}
            role="presentation"
            onFocusIn={() => setOpen(true)}
            onFocusOut={handleFocusOut}
            onKeyDown={blurOnEscape}
        >
            <button
                type="button"
                className={triggerClassName}
                aria-expanded={open}
                aria-controls={menuId}
                aria-describedby={describedBy}
            >
                {trigger}
            </button>
            <ul id={menuId} tabIndex={-1} className={`dropdown-content ${menuClassName}`}>
                {children}
            </ul>
        </div>
    );
}
