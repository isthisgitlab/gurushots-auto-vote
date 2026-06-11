import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from '@/contexts/TranslationContext';

// Main page is window-scrolled; show the button once past this many pixels.
const SCROLL_THRESHOLD = 300;

/**
 * Floating button that smooth-scrolls the window back to the top.
 * Hidden until the page is scrolled past the threshold.
 */
export function ScrollToTopButton() {
    const { t } = useTranslation();
    const [visible, setVisible] = useState(false);

    useEffect(() => {
        const onScroll = () => setVisible(window.scrollY > SCROLL_THRESHOLD);
        onScroll();
        window.addEventListener('scroll', onScroll, { passive: true });
        return () => window.removeEventListener('scroll', onScroll);
    }, []);

    const handleClick = useCallback(() => {
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }, []);

    if (!visible) {
        return null;
    }

    return (
        <button
            className="btn btn-circle btn-primary shadow-lg fixed right-4 bottom-[calc(1rem+env(safe-area-inset-bottom))] z-40"
            onClick={handleClick}
            title={t('app.scrollToTop')}
            aria-label={t('app.scrollToTop')}
        >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 15l7-7 7 7" />
            </svg>
        </button>
    );
}
