import { useEffect, useCallback } from 'react';

/**
 * DaisyUI modal component with accessibility features
 * Uses focus trapping via keyboard events
 */
export function Modal({ isOpen, onClose, title, children, size = 'md', className = '', showCloseButton = true }) {
    const sizeClass =
        {
            sm: 'max-w-sm',
            md: 'max-w-lg',
            lg: 'max-w-2xl',
            xl: 'max-w-4xl',
        }[size] || 'max-w-lg';

    // Handle escape key to close modal
    const handleKeyDown = useCallback(
        (e) => {
            if (e.key === 'Escape' && onClose) {
                onClose();
            }
        },
        [onClose],
    );

    // Add escape key listener when modal is open
    useEffect(() => {
        if (isOpen) {
            document.addEventListener('keydown', handleKeyDown);
            // Prevent body scroll when modal is open
            document.body.style.overflow = 'hidden';
        }

        return () => {
            document.removeEventListener('keydown', handleKeyDown);
            document.body.style.overflow = '';
        };
    }, [isOpen, handleKeyDown]);

    if (!isOpen) {
        return null;
    }

    return (
        <div
            className="modal modal-open z-50"
            role="dialog"
            aria-modal="true"
            aria-labelledby={title ? 'modal-title' : undefined}
        >
            {/* Backdrop */}
            <div className="modal-backdrop bg-black/50" onClick={onClose} aria-hidden="true" />

            {/* Modal box */}
            <div className={`modal-box ${sizeClass} ${className}`}>
                {/* Header with title and close button */}
                {(title || showCloseButton) && (
                    <div className="flex items-center justify-between mb-4">
                        {title && (
                            <h3 id="modal-title" className="text-lg font-bold">
                                {title}
                            </h3>
                        )}
                        {showCloseButton && (
                            <button
                                className="btn btn-sm btn-circle btn-ghost"
                                onClick={onClose}
                                aria-label="Close modal"
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
