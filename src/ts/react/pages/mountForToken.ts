/**
 * Mount Login or App into #root for the single-document shells (Capacitor,
 * web). Electron swaps windows on login/logout (index/windows.ts createLoginWindow
 * vs createMainWindow); these shells swap React trees instead, after clearing the
 * DOM — otherwise React's reconciler hits removeChild errors when its expected
 * DOM does not match what the previous tree left behind.
 */

import { mountApp } from './App';
import { mountLogin } from './Login';

import type { BackgroundHost } from '../../core/autovote/controller';

/**
 * The app root still standing, if any. It holds the autovote controller's
 * timers, so a swap must unmount it — not just empty its DOM — before the
 * next tree mounts. Login's own root holds no controller and mountLogin is
 * not touched here, so only the app root is tracked.
 */
let appRoot: ReturnType<typeof mountApp> = null;

/**
 * @param hasToken - whether a session token is stored; without one Login mounts
 * @param startupError - an IPC failure to show on Login (the shell could not read the session state)
 * @param backgroundHost - the autovote controller's background host (the shell's choice; mountApp defaults to the no-op host)
 */
export const mountForToken = (hasToken: boolean, startupError?: string, backgroundHost?: BackgroundHost) => {
    // Unmount the previous app tree first: the unmount runs its effects'
    // cleanups (the autovote controller's dispose) while its DOM still exists.
    appRoot?.unmount();
    appRoot = null;
    const container = document.getElementById('root');
    if (container) {
        while (container.firstChild) container.removeChild(container.firstChild);
    }
    if (hasToken) {
        appRoot = mountApp(backgroundHost);
    } else {
        mountLogin(startupError);
    }
};
