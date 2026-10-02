import { isAppFileUrl } from '../appFileUrl';
import { isOpenableLinkUrl } from '../format/urlSafe';
import * as logger from '../logger';

import type { App, Event, Shell, WebContents } from 'electron';

/**
 * Window-open and navigation policy for every web contents the app creates.
 *
 * A window has the preload's `window.api`, and the `persist:gurushots` session
 * is shared, so a window must never leave the app's own pages: API-sourced
 * content (a challenge's welcome message) carries links, and a local document
 * can be dropped onto a window. Nothing opens a new window; a link the user
 * follows goes to the system browser or mail client when it is a plain
 * http(s)/mailto: URL, and is refused otherwise. A window navigates only to
 * its own current URL (reload) or to one of the app's pages.
 */

const log = () => logger.withCategory('ui');

// Hands a link to the OS; a failure is logged, never thrown into Electron's event loop.
const openLink = (shell: Shell, url: string) => {
    shell.openExternal(url).catch((error) => {
        log().error(`Failed to open ${url} externally:`, error);
    });
};

const guardContents = (shell: Shell, contents: WebContents) => {
    contents.setWindowOpenHandler(({ url }) => {
        if (isOpenableLinkUrl(url)) {
            openLink(shell, url);
        } else {
            log().warning(`Refused window.open to ${url}`, null);
        }
        return { action: 'deny' };
    });

    const guardNavigation = (event: Event, url: string) => {
        if (url === contents.getURL() || isAppFileUrl(url)) return;
        event.preventDefault();
        if (isOpenableLinkUrl(url)) {
            openLink(shell, url);
        } else {
            log().warning(`Refused navigation to ${url}`, null);
        }
    };
    contents.on('will-navigate', guardNavigation);
    contents.on('will-redirect', guardNavigation);
};

/**
 * Guards every web contents created from now on. Call at module load, before
 * the first window exists.
 */
const register = (app: App, shell: Shell) => {
    app.on('web-contents-created', (_event, contents) => guardContents(shell, contents));
};

export { register };
