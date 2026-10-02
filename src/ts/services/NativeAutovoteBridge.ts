/**
 * Bridge to the custom Capacitor plugin (AutoVoteBackground) that
 * runs the voting cycle natively via a Foreground Service +
 * AlarmManager. Needed because the WebView / Activity dies when the
 * user swipes the app from recents, so any JS-side setInterval also
 * dies. The native plugin survives that and Doze deep-sleep.
 *
 * No-op on Electron, CLI, and non-Capacitor builds. The plugin is
 * lazy-required and the runtime.isCapacitor() guard short-circuits
 * before any native call is attempted.
 */

import * as runtime from '../runtime';
import * as logger from '../logger';

import type { AutoVoteBackgroundPlugin, CapacitorGlobals } from '../types/capacitor';
import { errorMessage } from '../errorMessage';

let pluginInstance: AutoVoteBackgroundPlugin | null = null;
const getPlugin = () => {
    if (!runtime.isCapacitor()) return null;
    if (pluginInstance) return pluginInstance;
    try {
        const cap = (globalThis as CapacitorGlobals).Capacitor;
        pluginInstance = cap?.Plugins?.AutoVoteBackground || null;
        if (!pluginInstance) {
            logger.withCategory('voting').warning('AutoVoteBackground plugin not registered on this build');
        }
        return pluginInstance;
    } catch (err) {
        logger.withCategory('voting').warning('NativeAutovoteBridge.getPlugin failed', errorMessage(err));
        return null;
    }
};

const callPlugin = async (action: 'start' | 'stop' | 'getStatus', logFailure: boolean) => {
    const plugin = getPlugin();
    if (!plugin) return { running: false, available: false };
    try {
        const result = await plugin[action]();
        return { ...result, available: true };
    } catch (err) {
        if (logFailure) logger.withCategory('voting').error(`AutoVoteBackground.${action} failed`, err);
        return {
            running: false,
            available: true,
            error: errorMessage(err),
        };
    }
};

const start = () => callPlugin('start', true);

const stop = () => callPlugin('stop', true);

const getStatus = () => callPlugin('getStatus', false);

const isAvailable = () => getPlugin() !== null;

export { start, stop, getStatus, isAvailable };
