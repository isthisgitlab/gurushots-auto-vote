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

import { installBridge, subscribe } from '../../bridge/capacitor';
import { initializeAsync as initSettings, getSetting } from '../../settings';
import { isCapacitor } from '../../runtime';
import { mountApp } from './App';
import { mountLogin } from './Login';

// Translations are loaded as a separate <script> tag in src/html/app.html
// for Electron, which puts window.translationManager in scope before
// app-bundle.js runs. Capacitor's index.html only loads
// capacitor-bundle.js, so we import the UMD modules here for their
// return values and assign the globals manually before React mounts.
//
// The translations manager uses loadScript() to dynamically fetch
// english.js / latvian.js when window.englishTranslations /
// window.latvianTranslations are not present. That fetch path does
// not work in a bundled Capacitor build (the language files are not
// emitted as separate files in dist/). Pre-importing them and
// setting the globals here skips the dynamic-load path entirely.
import * as translationsModule from '../../translations';
import * as englishModule from '../../translations/english';
import * as latvianModule from '../../translations/latvian';
const translations = translationsModule.default || translationsModule;
const english = englishModule.default || englishModule;
const latvian = latvianModule.default || latvianModule;
if (translations?.translationManager) {
    globalThis.translationManager = translations.translationManager;
    globalThis.translations = translations.translations;
}
if (english) globalThis.englishTranslations = english;
if (latvian) globalThis.latvianTranslations = latvian;

// Mount Login or App based on whether we have a token. Electron's
// index.js picks this via createLoginWindow vs createMainWindow and
// swaps windows on login/logout; Capacitor has only one WebView so
// we swap React trees and rely on a clean DOM reset between mounts
// (otherwise React's reconciler hits removeChild errors when its
// expected DOM does not match).
const mountForCurrentAuthState = () => {
    let token;
    try {
        token = getSetting('token') || '';
    } catch {
        token = '';
    }
    const container = document.getElementById('root');
    if (container) {
        while (container.firstChild) container.removeChild(container.firstChild);
    }
    console.log('[capacitor-entry] mounting', token ? 'App' : 'Login', '— token present:', !!token);
    if (token) {
        mountApp();
    } else {
        mountLogin();
    }
};

const bootstrap = async () => {
    if (isCapacitor()) {
        installBridge();
        await initSettings();
    }
    // Translations need an explicit load — the UMD factory just
    // constructs a TranslationManager with initialized=false. Electron
    // gets this for free because src/html/app.html loads it as a
    // separate <script> and the main process triggers loadLanguage
    // during startup; on Capacitor we have to drive it ourselves so
    // TranslationContext sees ready=true and the React tree renders
    // strings instead of raw keys (app.title, app.startAutoVote, ...).
    if (globalThis.translationManager?.loadLanguageFromSettings) {
        try {
            await globalThis.translationManager.loadLanguageFromSettings();
        } catch (err) {
            console.error('Translation load failed:', err);
        }
    }

    // Wire login-success / logout from the bridge to swap mounts.
    // Login.jsx calls window.api.login() after a successful auth;
    // App.jsx calls window.api.logout() from the navbar's logout button.
    subscribe('login-success', () => mountForCurrentAuthState());
    subscribe('logout', () => mountForCurrentAuthState());

    mountForCurrentAuthState();
};

bootstrap().catch((err) => {
    console.error('Capacitor bootstrap failed:', err);
    // Still attempt to mount so the user sees a useful error rather
    // than a blank screen. The React tree will surface the failure
    // through normal error boundaries / settings-loading state.
    mountForCurrentAuthState();
});
