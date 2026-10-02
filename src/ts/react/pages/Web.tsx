/**
 * Web entry point — the renderer in an ordinary browser tab, served by the
 * web shell (web/server.ts, `pnpm web`). Installs the fetch/SSE window.api
 * bridge, then mounts Login or App from the token the server holds, and swaps
 * them on login/logout like the Capacitor entry.
 *
 * dist/web.html loads the bundle this file produces. Electron and Capacitor
 * never load it.
 */

import type { RendererGlobals } from '../../types/capacitor';

// Tell App.tsx and Login.tsx not to auto-mount when imported below. The
// import must happen after this assignment.
(globalThis as RendererGlobals).__capacitorBootstrap = true;

import { installWebBridge, onShellEvent } from '../../bridge/web';
import { getSettings, logRendererError } from '../api/ipc';
import { errorMessage } from '../../errorMessage';
import { mountForToken } from './mountForToken';

const mountForCurrentAuthState = async () => {
    let hasToken = false;
    try {
        hasToken = (await getSettings()).hasToken;
    } catch (err) {
        // Server unreachable: Login shows, and its own calls surface the error.
        await logRendererError(`Web UI could not read the session state: ${errorMessage(err)}`);
    }
    mountForToken(hasToken);
};

installWebBridge();
onShellEvent('login-success', () => void mountForCurrentAuthState());
onShellEvent('logout', () => void mountForCurrentAuthState());
void mountForCurrentAuthState();
