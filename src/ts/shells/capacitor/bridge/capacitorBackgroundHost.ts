/**
 * The autovote controller's background host for the Capacitor (Android) shell,
 * over the two bridges:
 *
 * Hand scheduling to the Android background host. On Capacitor the native
 * AutoVote plugin owns the foreground notification, AlarmManager schedule and
 * per-cycle HTTP work — voting continues even when the WebView is destroyed
 * (app swiped from recents). Where the native plugin is not available, fall
 * back to the foreground-notification-only plugin so there is still a visual
 * indicator. Both are no-ops on Electron (the shell only wires this host from
 * shells/capacitor/page.tsx).
 */

import * as foregroundService from '../ForegroundServiceController';
import * as nativeAutovote from '../NativeAutovoteBridge';

import type { BackgroundHost } from '../../../core/autovote/controller';

const start = async (preparingText: string): Promise<void> => {
    const native = await nativeAutovote.start();
    if (!native.available) {
        await foregroundService.start({ body: preparingText });
    }
};

/**
 * Stop the native background loop (the plugin tears down its own foreground
 * notification), falling back to the simple foreground-service controller
 * when native is not available.
 */
const stop = async (): Promise<void> => {
    const native = await nativeAutovote.stop();
    if (!native.available) {
        await foregroundService.stop();
    }
};

// Today's payload shape: only the body is passed, so the service keeps its
// own app-name title; the controller hands over the translated strings.
const update = (_title: string, body: string): Promise<void> => foregroundService.update({ body });

const status = () => nativeAutovote.getStatus();

export const capacitorBackgroundHost: BackgroundHost = { start, stop, update, status };
