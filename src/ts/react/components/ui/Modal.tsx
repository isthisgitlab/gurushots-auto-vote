import { useLayoutEffect, useCallback, useRef, useId } from 'react';
import { rendererTranslator } from '../../../translations/renderer';
import { StrokeIcon, ICON_PATHS } from './StrokeIcon';
import type { ComponentChildren } from 'preact';

// The elements Tab can land on inside the dialog.
const FOCUSABLE_SELECTOR =
    'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

// The open modals, outermost first. A modal can open from inside another (the
// photo chooser from a settings modal); only the topmost one answers Escape and
// Tab, and the page scroll lock outlives all but the last to close.
const openModalIds: string[] = [];

const isTopmost = (id: string): boolean => openModalIds[openModalIds.length - 1] === id;

/**
 * Keep this modal on the stack while it is open. Its own effect, keyed on the
 * open state alone: handleKeyDown changes with every new onClose, and
 * re-registering then would move a modal above one opened from inside it.
 */
function useModalStack(isOpen: boolean, id: string) {
    useLayoutEffect(() => {
        if (!isOpen) return undefined;
        openModalIds.push(id);
        // Prevent body scroll when modal is open
        document.body.style.overflow = 'hidden';
        return () => {
            openModalIds.splice(openModalIds.indexOf(id), 1);
            document.body.style.overflow = openModalIds.length > 0 ? 'hidden' : '';
        };
    }, [isOpen, id]);
}

// Close-button label, read from the page translator rather than the
// useTranslation hook so this generic UI primitive stays usable outside a
// TranslationProvider.
const closeLabel = () => rendererTranslator.t('common.closeModal');

/**
 * Props of Modal. `onClose` is optional: without it Escape, the backdrop and
 * the close button do nothing (a modal that must not be dismissed).
 */
export interface ModalProps {
    isOpen: boolean;
    onClose?: () => void;
    title?: ComponentChildren;
    children?: ComponentChildren;
    size?: 'sm' | 'md' | 'lg' | 'xl' | '2xl';
    className?: string;
    showCloseButton?: boolean;
}

/**
 * DaisyUI modal with accessibility features: role=dialog / aria-modal, Escape
 * to close, a focus trap that keeps Tab / Shift+Tab cycling within the dialog,
 * and focus restoration to the triggering element when the modal closes.
 */
export function Modal({
    isOpen,
    onClose,
    title,
    children,
    size = 'md',
    className = '',
    showCloseButton = true,
}: ModalProps) {
    // DaisyUI's .modal-box is `width: 91.666667%` capped by its max-width, so a
    // larger cap here fills more of a desktop window without hurting phones —
    // the percentage keeps the gutter on narrow viewports either way.
    const sizeClass =
        {
            sm: 'max-w-sm',
            md: 'max-w-lg',
            lg: 'max-w-2xl',
            xl: 'max-w-4xl',
            '2xl': 'max-w-6xl',
        }[size] || 'max-w-lg';

    // Per-instance id so aria-labelledby is unique even when two titled modals
    // are mounted at once (a hardcoded id would make a screen reader announce
    // the wrong dialog title).
    const titleId = useId();
    const modalBoxRef = useRef<HTMLDivElement | null>(null);
    // The element focused before the modal opened, restored on close.
    const previouslyFocusedRef = useRef<(Element & Partial<HTMLOrSVGElement>) | null>(null);

    // Only called while the dialog is mounted and open (the open effect and the
    // keydown listener it owns), so the box ref is always attached here.
    const getFocusable = useCallback(
        () => Array.from((modalBoxRef.current as HTMLDivElement).querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)),
        [],
    );

    const handleKeyDown = useCallback(
        (e: KeyboardEvent) => {
            if (!isTopmost(titleId)) return;
            if (e.key === 'Escape') {
                if (onClose) onClose();
                return;
            }
            if (e.key !== 'Tab') return;

            // Focus trap: keep Tab cycling within the dialog. With nothing
            // focusable, pin focus on the box itself.
            const focusable = getFocusable();
            const box = modalBoxRef.current;
            if (focusable.length === 0) {
                e.preventDefault();
                box?.focus();
                return;
            }
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            const active = document.activeElement;
            const inside = box?.contains(active);
            if (e.shiftKey && (active === first || !inside)) {
                e.preventDefault();
                last.focus();
            } else if (!e.shiftKey && (active === last || !inside)) {
                e.preventDefault();
                first.focus();
            }
        },
        [onClose, getFocusable, titleId],
    );

    useLayoutEffect(() => {
        if (!isOpen) return undefined;

        // Remember the trigger so focus can return to it on close.
        previouslyFocusedRef.current = document.activeElement;
        document.addEventListener('keydown', handleKeyDown);
        // Move focus into the dialog (first focusable element, else the box).
        const focusable = getFocusable();
        (focusable[0] || modalBoxRef.current)?.focus();

        return () => {
            document.removeEventListener('keydown', handleKeyDown);
            const prev = previouslyFocusedRef.current;
            if (prev && typeof prev.focus === 'function') prev.focus();
        };
    }, [isOpen, handleKeyDown, getFocusable]);

    useModalStack(isOpen, titleId);

    if (!isOpen) {
        return null;
    }

    return (
        <div
            className="modal modal-open z-50"
            role="dialog"
            aria-modal="true"
            aria-labelledby={title ? titleId : undefined}
        >
            {/* Backdrop */}
            <div className="modal-backdrop bg-black/50" onClick={onClose} aria-hidden="true" />

            {/* Modal box */}
            <div ref={modalBoxRef} tabIndex={-1} className={`modal-box ${sizeClass} ${className}`}>
                {/* Header with title and close button */}
                {(title || showCloseButton) && (
                    <div className="flex items-center justify-between mb-4">
                        {title && (
                            <h3 id={titleId} className="text-lg font-bold">
                                {title}
                            </h3>
                        )}
                        {showCloseButton && (
                            <button
                                className="btn btn-sm btn-square btn-outline"
                                onClick={onClose}
                                aria-label={closeLabel()}
                            >
                                <StrokeIcon className="w-4 h-4" d={ICON_PATHS.close} />
                            </button>
                        )}
                    </div>
                )}

                {/* Content */}
                {children}
            </div>
        </div>
    );
}

/**
 * Modal action buttons container
 */
export function ModalActions({ children, className = '' }: { children?: ComponentChildren; className?: string }) {
    return <div className={`modal-action ${className}`}>{children}</div>;
}
