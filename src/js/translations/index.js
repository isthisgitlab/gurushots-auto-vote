/**
 * Node translation manager (Electron main process): the shared translator
 * core plus language persistence through the settings facade.
 *
 * Node-only — the renderer bundles import translations/renderer.js instead,
 * because requiring the settings facade here would pull zod into every page
 * bundle.
 */

const { createTranslator } = require('./translator');
const settings = require('../settings');
const logger = require('../logger');

const translator = createTranslator();

const translationManager = {
    ...translator,

    /** Adopt the language saved in settings; on failure keep the current one. */
    async loadLanguageFromSettings() {
        try {
            translator.setCurrentLanguage(settings.getSetting('language'));
        } catch (error) {
            logger.withCategory('translation').warning('Could not load language from settings:', error);
        }
    },
};

void translationManager.loadLanguageFromSettings();

module.exports = { translationManager };
