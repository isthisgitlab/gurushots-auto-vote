// Translation system for GuruShots Auto Vote
/* global window, document, self */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        // Node.js
        module.exports = factory();
    } else {
        // Browser globals
        const result = factory();
        root.translationManager = result.translationManager;
        root.translations = result.translations;
    }
}(typeof self !== 'undefined' ? self : typeof window !== 'undefined' ? window : this, function () {

    // Translation cache
    const translationCache = {};

    // Translation utility functions
    class TranslationManager {
        constructor() {
            this.currentLanguage = 'en'; // Default language
            this.initialized = false;
            this.init();
        }

        async init() {
        // Wait a bit for window.api to be available
            if (typeof window !== 'undefined' && !window.api) {
            // Wait for window.api to be available
                let attempts = 0;
                while (!window.api && attempts < 50) {
                    await new Promise(resolve => setTimeout(resolve, 100));
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
                // Try to use the logger if available (browser context), fallback to console.warn
                if (typeof window !== 'undefined' && window.api && window.api.logDebug) {
                    window.api.logDebug(`Could not load translations for ${language}: ${error.message}`);
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

        // Load language from settings
        async loadLanguageFromSettings() {
            try {
                let savedLanguage;
            
                // Check if we're in a browser context with window.api
                if (typeof window !== 'undefined' && window.api && window.api.getSettings) {
                    const settings = await window.api.getSettings();
                    savedLanguage = settings.language;
                } else {
                // Fallback for Node.js context
                    try {
                        const settings = require('../settings');
                        savedLanguage = settings.getSetting('language');
                    } catch (error) {
                        const logger = require('../logger');
                        logger.warning('Could not load language from settings (Node.js):', error);
                    }
                }
            
                // Load translations for the saved language
                await this.loadTranslations(savedLanguage);
                this.currentLanguage = savedLanguage;
            
            } catch (error) {
                const logger = require('../logger');
                logger.warning('Could not load language from settings:', error);
            }
        }

        // Save language to settings
        async saveLanguageToSettings(language) {
            try {
            // Load translations for the new language first
                await this.loadTranslations(language);
            
                // Check if we're in a browser context with window.api
                if (typeof window !== 'undefined' && window.api && window.api.setSetting) {
                    await window.api.setSetting('language', language);
                    this.currentLanguage = language;
                } else {
                // Fallback for Node.js context
                    try {
                        const settings = require('../settings');
                        settings.setSetting('language', language);
                        this.currentLanguage = language;
                    } catch (error) {
                        const logger = require('../logger');
                        logger.error('Could not save language to settings (Node.js):', error);
                    }
                }
            } catch (error) {
                const logger = require('../logger');
                logger.error('Could not save language to settings:', error);
            }
        }

        // Get translation for a key
        t(key) {
            const keys = key.split('.');
            let value = translationCache[this.currentLanguage];

            for (const k of keys) {
                if (value && value[k]) {
                    value = value[k];
                } else {
                // Fallback to English if translation not found
                    value = translationCache.en;
                    if (!value && this.currentLanguage !== 'en') {
                    // Try to load English as fallback
                        // Try to use the logger if available (browser context), fallback to console.warn
                        if (typeof window !== 'undefined' && window.api && window.api.logDebug) {
                            window.api.logDebug(`Fallback to English for key: ${key}`);
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

            return value || key;
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

}));