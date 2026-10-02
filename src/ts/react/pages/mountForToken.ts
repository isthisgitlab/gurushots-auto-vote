/**
 * Mount Login or App into #root for the single-document shells (Capacitor,
 * web). Electron swaps windows on login/logout (index/windows.ts createLoginWindow
 * vs createMainWindow); these shells swap React trees instead, after clearing the
 * DOM — otherwise React's reconciler hits removeChild errors when its expected
 * DOM does not match what the previous tree left behind.
 */

import { mountApp } from './App';
import { mountLogin } from './Login';

/**
 * @param hasToken - whether a session token is stored; without one Login mounts
 */
export const mountForToken = (hasToken: boolean) => {
    const container = document.getElementById('root');
    if (container) {
        while (container.firstChild) container.removeChild(container.firstChild);
    }
    if (hasToken) {
        mountApp();
    } else {
        mountLogin();
    }
};
