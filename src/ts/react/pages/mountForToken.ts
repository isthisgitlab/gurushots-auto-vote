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
 * @param token - the stored auth token; empty mounts Login
 */
export const mountForToken = (token: string) => {
    const container = document.getElementById('root');
    if (container) {
        while (container.firstChild) container.removeChild(container.firstChild);
    }
    if (token) {
        mountApp();
    } else {
        mountLogin();
    }
};
