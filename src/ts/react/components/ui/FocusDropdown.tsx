import { useId, useRef, useState } from 'react';

import type { ComponentChildren, TargetedFocusEvent, TargetedKeyboardEvent } from 'preact';

/**
 * A DaisyUI dropdown whose trigger is a real `<button>` (focusable, Enter and Space work) that discloses the list
 * (`aria-expanded`, `aria-controls`). The list is plain buttons, not an ARIA menu, so the trigger does not claim
 * `aria-haspopup` (its default, "menu", would misannounce it). Opening is CSS-driven by focus within the wrapper;
 * `aria-expanded` follows the same focus so assistive tech hears the state. The menu closes when focus leaves, and
 * on Escape, which returns focus to the trigger (DaisyUI's `dropdown-close` keeps it shut while focus stays inside);
 * activating the trigger opens it again.
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
    const [dismissed, setDismissed] = useState(false);
    const menuId = useId();
    const triggerRef = useRef<HTMLButtonElement>(null);
    // Set while Escape moves focus to the trigger, so that focus move does not read as opening the menu.
    const escaping = useRef(false);
    const reopen = () => {
        setDismissed(false);
        setOpen(true);
    };
    const handleFocusIn = () => {
        if (escaping.current) {
            escaping.current = false;
            return;
        }
        reopen();
    };
    const handleFocusOut = (e: TargetedFocusEvent<HTMLElement>) => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        setOpen(false);
        setDismissed(false);
    };
    // Attached to the wrapper, so it sees keys from the trigger and every entry button inside.
    const handleKeyDown = (e: TargetedKeyboardEvent<HTMLElement>) => {
        if (e.key !== 'Escape') return;
        setOpen(false);
        setDismissed(true);
        const trigger = triggerRef.current;
        if (trigger && e.target !== trigger) {
            escaping.current = true;
            trigger.focus();
        }
    };
    return (
        <div
            className={`dropdown ${dismissed ? 'dropdown-close ' : ''}${className}`.trim()}
            role="presentation"
            onFocusIn={handleFocusIn}
            onFocusOut={handleFocusOut}
            onKeyDown={handleKeyDown}
        >
            <button
                ref={triggerRef}
                type="button"
                className={triggerClassName}
                aria-expanded={open}
                aria-controls={menuId}
                aria-describedby={describedBy}
                onClick={reopen}
            >
                {trigger}
            </button>
            <ul id={menuId} tabIndex={-1} className={`dropdown-content ${menuClassName}`}>
                {children}
            </ul>
        </div>
    );
}
