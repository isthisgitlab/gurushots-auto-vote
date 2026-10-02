import { session } from 'electron';
import * as logger from '../logger';

import type { Session, WebContents } from 'electron';

/**
 * Permission policy for every session the app's windows use.
 *
 * Electron grants a permission request unless a handler says otherwise, so a
 * page that reached the shared `persist:gurushots` session would get camera,
 * geolocation and the rest. The only permission the app uses is notifications
 * (react/notifications/deadlineNotifier.ts), and only from its own `file:`
 * pages.
 *
 * The page is judged on `webContents.getURL()`, never on a check's
 * `requestingOrigin`: Electron reports a `file:` page's origin as `file:///`
 * regardless of which file it is.
 */

const allows = (webContents: WebContents | null, permission: string): boolean =>
    permission === 'notifications' && !!webContents && webContents.getURL().startsWith('file:');

const deny = (kind: 'request' | 'check', webContents: WebContents | null, permission: string) => {
    logger
        .withCategory('ui')
        .warning(`Denied permission ${kind} '${permission}' from ${webContents?.getURL() ?? '<unknown>'}`, null);
};

const lockDown = (target: Session) => {
    target.setPermissionRequestHandler((webContents, permission, callback) => {
        const allowed = allows(webContents, permission);
        if (!allowed) deny('request', webContents, permission);
        callback(allowed);
    });
    target.setPermissionCheckHandler((webContents, permission) => {
        const allowed = allows(webContents, permission);
        if (!allowed) deny('check', webContents, permission);
        return allowed;
    });
};

/**
 * Installs the policy on the default session and on the app windows' persistent
 * partition. Call once Electron is ready, before the first window is created.
 */
const installPermissionHandlers = () => {
    lockDown(session.defaultSession);
    lockDown(session.fromPartition('persist:gurushots'));
};

export { installPermissionHandlers };
