/**
 * Node translation manager (Electron main process): the shared translator
 * core plus language persistence through the settings facade.
 *
 * Node-only — the renderer bundles import translations/renderer.ts instead,
 * because requiring the settings facade here would pull zod into every page
 * bundle.
 */

import { createTranslator } from './translator';
import * as settings from '../settings';
import * as logger from '../logger';

const translator = createTranslator();

const translationManager = {
    ...translator,

    /**
     * Adopt the installation's effective language (the saved one, or a running scenario's published one over it; the native menu
     * follows what the windows paint). A language that cannot be read keeps the current one, as does a failure.
     */
    async loadLanguageFromSettings() {
        try {
            const effective = settings.readInstallationSetting('language');
            if (effective.state === 'known' && effective.value.kind === 'string') {
                translator.setCurrentLanguage(effective.value.value);
            }
        } catch (error) {
            logger.withCategory('translation').warning('Could not load language from settings:', error);
        }
    },
};

void translationManager.loadLanguageFromSettings();

export { translationManager };
