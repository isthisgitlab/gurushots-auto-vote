import { createContext, useContext, useCallback, useEffect, useMemo } from 'react';
import { rendererTranslator } from '../../translations/renderer';
import { DEFAULT_LANGUAGE, isSupportedLanguage, resolveLanguage } from '../../translations/translator';
import { useIpcQuery } from '../api/useIpcQuery';
import * as ipc from '../api/ipc';

/** @import { ComponentChildren } from 'preact' */
/** @import { IpcQueryTools } from '../api/useIpcQuery' */

/**
 * What useTranslation returns.
 *
 * @typedef {object} TranslationContextValue
 * @property {(key: string) => string} t - the key's text in the current language
 * @property {string} language
 * @property {(lang: string) => Promise<boolean>} setLanguage - resolves whether the language was saved
 * @property {() => string} getCurrentLanguage
 * @property {boolean} ready
 */

const TranslationContext = createContext(/** @type {TranslationContextValue | null} */ (null));

const fetchLanguage = () => ipc.getSetting('language');

// Hand the saved language to the page translator before publishing it, so
// hook-less consumers (ErrorBoundary, Modal) render in the same language.
/**
 * @param {unknown} saved
 * @param {Pick<IpcQueryTools<string, Error>, 'setData'>} tools
 */
const applyLanguage = (saved, { setData }) => {
    const language = resolveLanguage(saved);
    rendererTranslator.setCurrentLanguage(language);
    setData(language);
};

/** Fire-and-forget: a language that failed to save is logged, never thrown. */
/** @param {unknown} reason */
const logLanguageSaveFailure = (reason) => {
    void ipc.logRendererError(`Could not save language to settings: ${reason}`);
};

/**
 * The renderer's translation adapter: reads the saved language through the
 * ipc module, persists changes the same way, follows a language saved
 * elsewhere (another window, the CLI) through settings-changed, and exposes
 * `t` bound to the current language. `ready` turns true once the saved
 * language has been read (or the read failed, leaving English).
 *
 * @param {{ children?: ComponentChildren }} props
 */
export function TranslationProvider({ children }) {
    const {
        data: language,
        setData,
        loading,
    } = useIpcQuery(fetchLanguage, { initialData: DEFAULT_LANGUAGE, apply: applyLanguage });

    // Every successful settings write broadcasts settings-changed, so a
    // language saved in another window (or edited through the CLI) lands here
    // without a reload, straight from the payload: no refetch, so `ready`
    // never flips back. A payload without `language` (a partial save-settings)
    // did not change it. This window's own setLanguage is echoed back too;
    // applying the same language again is a no-op.
    useEffect(
        () =>
            ipc.onSettingsChanged((/** @type {{ language?: unknown } | null | undefined} */ changed) => {
                if (changed?.language === undefined) return;
                applyLanguage(changed.language, { setData });
            }),
        [setData],
    );

    // A new `t` per language re-renders memoized consumers, so the text
    // always matches `language`.
    const t = useCallback(
        /**
         * @param {string} key
         * @returns {string}
         */
        (key) => rendererTranslator.t(key, language),
        [language],
    );

    // Persist first; the UI switches only once the language is saved. The
    // set-setting handler reports a rejected write as `false` rather than
    // throwing, so both outcomes count as a failed save. Resolves whether the
    // language was saved. A saved change also reloads the main process's
    // translator and native menu (refresh-menu; a no-op stub on Capacitor),
    // best-effort, from this one place.
    const setLanguage = useCallback(
        /** @param {string} lang */
        async (lang) => {
            if (!isSupportedLanguage(lang)) return false;
            let saved;
            try {
                saved = await ipc.setSetting('language', lang);
            } catch (error) {
                logLanguageSaveFailure(
                    /** @type {{ message?: unknown } | null | undefined} */ (error)?.message ?? error,
                );
                return false;
            }
            if (saved === false) {
                logLanguageSaveFailure('the settings store rejected the write');
                return false;
            }
            rendererTranslator.setCurrentLanguage(lang);
            setData(lang);
            Promise.resolve(ipc.refreshMenu()).catch(() => {});
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
 * @returns {TranslationContextValue}
 */
export function useTranslation() {
    const context = useContext(TranslationContext);
    if (!context) {
        throw new Error('useTranslation must be used within a TranslationProvider');
    }
    return context;
}
