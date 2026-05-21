import { useEffect, useCallback, useRef, useId } from 'react';

// The elements Tab can land on inside the dialog.
const FOCUSABLE_SELECTOR =
    'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

// Close-button label, read from the global translation singleton rather than
// the useTranslation hook so this generic UI primitive stays usable outside a
// TranslationProvider. Falls back to English if the manager isn't ready.
const closeLabel = () => window.translationManager?.t?.('common.closeModal') || 'Close modal';

/**
 * DaisyUI modal with accessibility features: role=dialog / aria-modal, Escape
 * to close, a focus trap that keeps Tab / Shift+Tab cycling within the dialog,
 * and focus restoration to the triggering element when the modal closes.
 */
export function Modal({ isOpen, onClose, title, children, size = 'md', className = '', showCloseButton = true }) {
    const sizeClass =
        {
            sm: 'max-w-sm',
            md: 'max-w-lg',
            lg: 'max-w-2xl',
            xl: 'max-w-4xl',
        }[size] || 'max-w-lg';

    // Per-instance id so aria-labelledby is unique even when two titled modals
    // are mounted at once (a hardcoded id would make a screen reader announce
    // the wrong dialog title).
    const titleId = useId();
    const modalBoxRef = useRef(null);
    // The element focused before the modal opened, restored on close.
    const previouslyFocusedRef = useRef(null);

    const getFocusable = useCallback(() => {
        const box = modalBoxRef.current;
        return box ? Array.from(box.querySelectorAll(FOCUSABLE_SELECTOR)) : [];
    }, []);

    const handleKeyDown = useCallback(
        (e) => {
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
        [onClose, getFocusable],
    );

    useEffect(() => {
        if (!isOpen) return undefined;

        // Remember the trigger so focus can return to it on close.
        previouslyFocusedRef.current = document.activeElement;
        document.addEventListener('keydown', handleKeyDown);
        // Prevent body scroll when modal is open
        document.body.style.overflow = 'hidden';
        // Move focus into the dialog (first focusable element, else the box).
        const focusable = getFocusable();
        (focusable[0] || modalBoxRef.current)?.focus();

        return () => {
            document.removeEventListener('keydown', handleKeyDown);
            document.body.style.overflow = '';
            const prev = previouslyFocusedRef.current;
            if (prev && typeof prev.focus === 'function') prev.focus();
        };
    }, [isOpen, handleKeyDown, getFocusable]);

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
                                className="btn btn-sm btn-circle btn-ghost"
                                onClick={onClose}
                                aria-label={closeLabel()}
                            >
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        strokeWidth="2"
                                        d="M6 18L18 6M6 6l12 12"
                                    />
                                </svg>
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
export function ModalActions({ children, className = '' }) {
    return <div className={`modal-action ${className}`}>{children}</div>;
}
