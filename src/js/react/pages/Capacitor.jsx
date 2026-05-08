/**
 * Capacitor entry point. Defers React mount until the bridge is
 * installed (so window.api exists when the first useSettings hook
 * fires) and settings.initializeAsync has hydrated the in-memory
 * cache from @capacitor/preferences. Then loads App and mounts it.
 *
 * dist/index.html (Capacitor's WebView entry) loads the bundle this
 * file produces, not app-bundle.js. Electron is unaffected; it never
 * loads this entry.
 */

// Tell App.jsx not to auto-mount when imported below. The import
// must happen after this assignment.
globalThis.__capacitorBootstrap = true;

import { installBridge } from '../../bridge/capacitor';
import { initializeAsync as initSettings } from '../../settings';
import { isCapacitor } from '../../runtime';
import { mountApp } from './App';

// Translations are loaded as a separate <script> tag in src/html/app.html
// for Electron, which puts window.translationManager in scope before
// app-bundle.js runs. Capacitor's index.html only loads
// capacitor-bundle.js, so we import the UMD module here for its return
// value and assign the globals manually before React mounts.
import * as translationsModule from '../../translations';
const translations = translationsModule.default || translationsModule;
if (translations?.translationManager) {
    globalThis.translationManager = translations.translationManager;
    globalThis.translations = translations.translations;
}

const bootstrap = async () => {
    if (isCapacitor()) {
        installBridge();
        await initSettings();
    }
    mountApp();
};

bootstrap().catch((err) => {
    console.error('Capacitor bootstrap failed:', err);
    // Still attempt to mount so the user sees a useful error rather
    // than a blank screen. The React tree will surface the failure
    // through normal error boundaries / settings-loading state.
    mountApp();
});
