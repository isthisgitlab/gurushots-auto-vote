import { session } from 'electron';
import * as logger from '../../../core/logger';
import { APP_PARTITION } from './session';

import type { Session, WebContents } from 'electron';

/**
 * Permission policy for every session the app's windows use.
 *
 * Electron grants a permission request unless a handler says otherwise, so a
 * page that reached the shared app-window session (`APP_PARTITION`) would get camera,
 * geolocation and the rest. The app uses two permissions, notifications
 * (react/notifications/deadlineNotifier.ts) and clipboard-sanitized-write (the
 * Remote access "Copy link" button, react/components/app/RemoteAccessSection.tsx),
 * both only from its own `file:` pages. A `media` check (never a request) from those pages
 * is also allowed: Chromium asks it before a peer connection, and without it WebRTC hides the
 * machine's local addresses behind `.local` names the remote-access phone cannot resolve, so the
 * pairing never connects. Camera and microphone stay denied — they go through the request handler.
 *
 * The page is judged on `webContents.getURL()`, never on a check's
 * `requestingOrigin`: Electron reports a `file:` page's origin as `file:///`
 * regardless of which file it is.
 */

const REQUESTABLE = new Set(['notifications', 'clipboard-sanitized-write']);
const CHECKABLE = new Set([...REQUESTABLE, 'media']);

const allows = (granted: Set<string>, webContents: WebContents | null, permission: string): boolean =>
    granted.has(permission) && !!webContents && webContents.getURL().startsWith('file:');

const deny = (kind: 'request' | 'check', webContents: WebContents | null, permission: string) => {
    logger
        .withCategory('ui')
        .warning(`Denied permission ${kind} '${permission}' from ${webContents?.getURL() ?? '<unknown>'}`, null);
};

const lockDown = (target: Session) => {
    target.setPermissionRequestHandler((webContents, permission, callback) => {
        const allowed = allows(REQUESTABLE, webContents, permission);
        if (!allowed) deny('request', webContents, permission);
        callback(allowed);
    });
    target.setPermissionCheckHandler((webContents, permission) => {
        const allowed = allows(CHECKABLE, webContents, permission);
        if (!allowed) deny('check', webContents, permission);
        return allowed;
    });
};

/**
 * Installs the policy on the default session and on the app windows' in-memory
 * partition. Call once Electron is ready, before the first window is created.
 */
const installPermissionHandlers = () => {
    lockDown(session.defaultSession);
    lockDown(session.fromPartition(APP_PARTITION));
};

export { installPermissionHandlers };
