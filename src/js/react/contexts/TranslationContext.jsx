import { createContext, useContext, useCallback, useMemo } from 'react';
import { rendererTranslator } from '../../translations/renderer';
import { DEFAULT_LANGUAGE, isSupportedLanguage, resolveLanguage } from '../../translations/translator';
import { useIpcQuery } from '../api/useIpcQuery';

const TranslationContext = createContext(null);

const fetchLanguage = () => window.api.getSetting('language');

// Hand the saved language to the page translator before publishing it, so
// hook-less consumers (ErrorBoundary, Modal) render in the same language.
const applyLanguage = (saved, { setData }) => {
    const language = resolveLanguage(saved);
    rendererTranslator.setCurrentLanguage(language);
    setData(language);
};

/** Fire-and-forget: a language that failed to save is logged, never thrown. */
const logLanguageSaveFailure = (reason) => {
    Promise.resolve(window.api.logError?.(`Could not save language to settings: ${reason}`)).catch(() => {});
};

/**
 * The renderer's translation adapter: reads the saved language over
 * window.api, persists changes the same way, and exposes `t` bound to the
 * current language. `ready` turns true once the saved language has been read
 * (or the read failed, leaving English).
 */
export function TranslationProvider({ children }) {
    const {
        data: language,
        setData,
        loading,
    } = useIpcQuery(fetchLanguage, { initialData: DEFAULT_LANGUAGE, apply: applyLanguage });

    // A new `t` per language re-renders memoized consumers, so the text
    // always matches `language`.
    const t = useCallback((key) => rendererTranslator.t(key, language), [language]);

    // Persist first; the UI switches only once the language is saved. The
    // set-setting handler reports a rejected write as `false` rather than
    // throwing, so both outcomes count as a failed save. Resolves whether the
    // language was saved. A saved change also reloads the main process's
    // translator and native menu (refresh-menu; a no-op stub on Capacitor),
    // best-effort, from this one place.
    const setLanguage = useCallback(
        async (lang) => {
            if (!isSupportedLanguage(lang)) return false;
            let saved;
            try {
                saved = await window.api.setSetting('language', lang);
            } catch (error) {
                logLanguageSaveFailure(error?.message ?? error);
                return false;
            }
            if (saved === false) {
                logLanguageSaveFailure('the settings store rejected the write');
                return false;
            }
            rendererTranslator.setCurrentLanguage(lang);
            setData(lang);
            Promise.resolve(window.api.refreshMenu?.()).catch(() => {});
            return true;
        },
        [setData],
    );

    const getCurrentLanguage = useCallback(() => language, [language]);

    const value = useMemo(
        () => ({ t, language, setLanguage, getCurrentLanguage, ready: !loading }),
        [t, language, setLanguage, getCurrentLanguage, loading],
    );

    return <TranslationContext.Provider value={value}>{children}</TranslationContext.Provider>;
}

/**
 * Hook to access translation context
 * @returns {{ t: function, language: string, setLanguage: function, getCurrentLanguage: function, ready: boolean }}
 */
export function useTranslation() {
    const context = useContext(TranslationContext);
    if (!context) {
        throw new Error('useTranslation must be used within a TranslationProvider');
    }
    return context;
}
