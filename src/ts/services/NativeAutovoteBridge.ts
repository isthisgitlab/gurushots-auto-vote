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
// A build without the plugin is looked at on every call (claim changes ask too): it is said once.
let warnedAbsent = false;
const getPlugin = () => {
    if (!runtime.isCapacitor()) return null;
    if (pluginInstance) return pluginInstance;
    try {
        const cap = (globalThis as CapacitorGlobals).Capacitor;
        pluginInstance = cap?.Plugins?.AutoVoteBackground || null;
        if (!pluginInstance && !warnedAbsent) {
            warnedAbsent = true;
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

/** What a compare-and-write came to: saved, or not because the store had changed (`current` is what it holds). */
type CompareAndWriteAnswer = { saved: boolean; current: string | null };

/**
 * Saves a side store (see AutoVotePlugin.compareAndWrite) only if it still holds `expected`. Null when there is no
 * native plugin (a build without the service): the caller is then the only writer. A rejection (a refused key or
 * value, a commit that failed) is the caller's to treat as not saved.
 */
const compareAndWrite = (key: string, expected: string | null, value: string): Promise<CompareAndWriteAnswer> | null =>
    getPlugin()?.compareAndWrite({ key, expected, value }) ?? null;

export { start, stop, getStatus, isAvailable, compareAndWrite };
