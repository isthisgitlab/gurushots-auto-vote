/**
 * Mount Login or App into #root for the single-document shells (Capacitor,
 * web). Electron swaps windows on login/logout (index/windows.ts createLoginWindow
 * vs createMainWindow); these shells swap React trees instead, after clearing the
 * DOM — otherwise React's reconciler hits removeChild errors when its expected
 * DOM does not match what the previous tree left behind.
 */

import { mountApp } from './App';
import { mountLogin } from './Login';

import type { BackgroundHost } from '../../autovote/controller';

/**
 * @param hasToken - whether a session token is stored; without one Login mounts
 * @param startupError - an IPC failure to show on Login (the shell could not read the session state)
 * @param backgroundHost - the autovote controller's background host (the shell's choice; mountApp defaults to the no-op host)
 */
export const mountForToken = (hasToken: boolean, startupError?: string, backgroundHost?: BackgroundHost) => {
    const container = document.getElementById('root');
    if (container) {
        while (container.firstChild) container.removeChild(container.firstChild);
    }
    if (hasToken) {
        mountApp(backgroundHost);
    } else {
        mountLogin(startupError);
    }
};
