// Translation system for GuruShots Auto Vote
/* global window, document, self */
(function (root, factory) {
    // The else branch is the classic <script>-tag load (src/html/*.html). Jest
    // always loads this file through its CommonJS wrapper, where `module` is
    // defined, so that branch cannot run under test.
    /* istanbul ignore else */
    if (typeof module === 'object' && module.exports) {
        // Node.js
        module.exports = factory();
    } else {
        // Browser globals
        const result = factory();
        root.translationManager = result.translationManager;
        root.translations = result.translations;
    }
})(typeof self !== 'undefined' ? self : typeof window !== 'undefined' ? window : this, function () {
    // Translation cache
    const translationCache = {};

    // Translation utility functions
    class TranslationManager {
        constructor() {
            this.currentLanguage = 'en'; // Default language
            this.initialized = false;
            void this.init();
        }

        async init() {
            // Wait a bit for window.api to be available
            if (typeof window !== 'undefined' && !window.api) {
                // Wait for window.api to be available
                let attempts = 0;
                while (!window.api && attempts < 50) {
                    await new Promise((resolve) => {
                        setTimeout(resolve, 100);
                    });
                    attempts++;
                }
            }
            await this.loadLanguageFromSettings();
            this.initialized = true;
        }

        // Load translations for a specific language
        async loadTranslations(language) {
            if (translationCache[language]) {
                return translationCache[language];
            }

            try {
                let translations;

                // Check if we're in a browser context
                if (typeof window !== 'undefined') {
                    // Browser context - dynamically load script
                    if (language === 'en' && !window.englishTranslations) {
                        await this.loadScript('../js/translations/english.js');
                    }
                    if (language === 'lv' && !window.latvianTranslations) {
                        await this.loadScript('../js/translations/latvian.js');
                    }

                    translations = language === 'en' ? window.englishTranslations : window.latvianTranslations;
                } else {
                    // Node.js context
                    translations = require(`./${language === 'en' ? 'english' : 'latvian'}`);
                }

                if (translations) {
                    translationCache[language] = translations;
                }

                return translations;
            } catch (error) {
                // Browser with the preload bridge ready → route through it.
                // True Node (CLI / Electron main) → the real logger. Browser
                // BEFORE window.api attaches must stay on console.warn: this
                // file also loads via a raw <script> tag (src/html/*.html)
                // where `require` does not exist.
                if (typeof window !== 'undefined' && window.api && window.api.logDebug) {
                    window.api.logDebug(`Could not load translations for ${language}: ${error.message}`);
                } else if (typeof window === 'undefined') {
                    require('../logger')
                        .withCategory('ui')
                        .warning(`Could not load translations for ${language}: ${error.message}`, null);
                } else {
                    console.warn(`Could not load translations for ${language}:`, error);
                }
                return null;
            }
        }

        // Load script dynamically in browser
        loadScript(src) {
            return new Promise((resolve, reject) => {
                const script = document.createElement('script');
                script.src = src;
                script.onload = resolve;
                script.onerror = reject;
                document.head.appendChild(script);
            });
        }

        // Reach the persisted settings: the preload bridge's `bridgeMethod`
        // in a renderer, else the Node settings facade. A bridge failure
        // propagates to the caller; a facade failure is logged at `level`
        // with `facadeFailure` and resolves undefined.
        async withSettings(bridgeMethod, viaBridge, viaFacade, level, facadeFailure) {
            if (typeof window !== 'undefined' && window.api && window.api[bridgeMethod]) {
                return viaBridge(window.api);
            }
            try {
                return viaFacade(require('../settings'));
            } catch (error) {
                require('../logger').withCategory('translation')[level](facadeFailure, error);
                return undefined;
            }
        }

        // Load language from settings
        async loadLanguageFromSettings() {
            try {
                const savedLanguage = await this.withSettings(
                    'getSettings',
                    async (api) => (await api.getSettings()).language,
                    (settings) => settings.getSetting('language'),
                    'warning',
                    'Could not load language from settings (Node.js):',
                );

                // Load translations for the saved language
                await this.loadTranslations(savedLanguage);
                this.currentLanguage = savedLanguage;
            } catch (error) {
                const logger = require('../logger');
                logger.withCategory('translation').warning('Could not load language from settings:', error);
            }
        }

        // Save language to settings
        async saveLanguageToSettings(language) {
            try {
                // Load translations for the new language first
                await this.loadTranslations(language);

                const saved = await this.withSettings(
                    'setSetting',
                    async (api) => {
                        await api.setSetting('language', language);
                        return true;
                    },
                    (settings) => {
                        settings.setSetting('language', language);
                        return true;
                    },
                    'error',
                    'Could not save language to settings (Node.js):',
                );
                if (saved) this.currentLanguage = language;
            } catch (error) {
                const logger = require('../logger');
                logger.withCategory('translation').error('Could not save language to settings:', error);
            }
        }

        // Get translation for a key, in `language` (default: the current one)
        t(key, language = this.currentLanguage) {
            const keys = key.split('.');
            let value = translationCache[language];

            for (const k of keys) {
                if (value && value[k]) {
                    value = value[k];
                } else {
                    // Fallback to English if translation not found
                    value = translationCache.en;
                    if (!value && language !== 'en') {
                        // Try to load English as fallback. Same three-way
                        // routing as loadTranslations: bridge → logger (Node
                        // only — the <script>-tag context has no require) →
                        // console.warn.
                        if (typeof window !== 'undefined' && window.api && window.api.logDebug) {
                            window.api.logDebug(`Fallback to English for key: ${key}`);
                        } else if (typeof window === 'undefined') {
                            require('../logger')
                                .withCategory('ui')
                                .warning(`Fallback to English for key: ${key}`, null);
                        } else {
                            console.warn(`Fallback to English for key: ${key}`);
                        }
                        return key;
                    }
                    for (const fallbackKey of keys) {
                        if (value && value[fallbackKey]) {
                            value = value[fallbackKey];
                        } else {
                            return key; // Return key if no translation found
                        }
                    }
                }
            }

            // Every path through the loop above either returns the key or leaves
            // `value` truthy, so no `|| key` fallback is needed here.
            return value;
        }

        // Get current language
        getCurrentLanguage() {
            return this.currentLanguage;
        }

        // Get available languages
        getAvailableLanguages() {
            return ['en', 'lv'];
        }

        // Set language
        async setLanguage(language) {
            if (['en', 'lv'].includes(language)) {
                await this.saveLanguageToSettings(language);
                return true;
            }
            return false;
        }
    }

    // Create instance for this context
    const translationManagerInstance = new TranslationManager();

    // Return the exports
    return {
        translationManager: translationManagerInstance,
        translations: translationCache,
    };
});
