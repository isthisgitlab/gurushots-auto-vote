import { useState, useCallback } from 'react';

/**
 * Open/closed state for a modal or panel, with stable `open` / `close`
 * callbacks (safe to pass straight to memoized children).
 *
 * @returns {{ isOpen: boolean, open: () => void, close: () => void }}
 */
export function useDisclosure() {
    const [isOpen, setIsOpen] = useState(false);
    const open = useCallback(() => setIsOpen(true), []);
    const close = useCallback(() => setIsOpen(false), []);
    return { isOpen, open, close };
}
