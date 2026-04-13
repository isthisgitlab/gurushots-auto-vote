import { createContext, useContext, useState, useCallback, useEffect } from 'react';

const TranslationContext = createContext(null);

/**
 * TranslationProvider bridges React with the existing window.translationManager
 * Waits for the translation manager to initialize before rendering children
 */
export function TranslationProvider({ children }) {
    const [language, setLanguageState] = useState('en');
    const [ready, setReady] = useState(false);

    useEffect(() => {
        // Wait for window.translationManager to initialize
        const checkInit = setInterval(() => {
            if (window.translationManager && window.translationManager.initialized) {
                setLanguageState(window.translationManager.getCurrentLanguage());
                setReady(true);
                clearInterval(checkInit);
            }
        }, 50);

        // Cleanup interval on unmount
        return () => clearInterval(checkInit);
    }, []);

    // Translate function - delegates to window.translationManager
    const t = useCallback((key) => {
        if (window.translationManager) {
            return window.translationManager.t(key);
        }
        return key;
    }, [language]); // Re-bind when language changes to trigger re-renders

    // Change language function
    const setLanguage = useCallback(async (lang) => {
        if (window.translationManager) {
            await window.translationManager.setLanguage(lang);
            setLanguageState(lang);
        }
    }, []);

    // Get current language
    const getCurrentLanguage = useCallback(() => {
        return language;
    }, [language]);

    const value = {
        t,
        language,
        setLanguage,
        getCurrentLanguage,
        ready,
    };

    return (
        <TranslationContext.Provider value={value}>
            {children}
        </TranslationContext.Provider>
    );
}

/**
 * Hook to access translation context
 * @returns {{ t: function, language: string, setLanguage: function, ready: boolean }}
 */
export function useTranslation() {
    const context = useContext(TranslationContext);
    if (!context) {
        throw new Error('useTranslation must be used within a TranslationProvider');
    }
    return context;
}
