/**
 * Bridge to the custom Capacitor plugin (AutoVoteBackground) that
 * runs the voting cycle natively via a Foreground Service +
 * AlarmManager. Needed because the WebView / Activity dies when the
 * user swipes the app from recents, so any JS-side setInterval also
 * dies. The native plugin survives that and Doze deep-sleep.
 *
 * No-op on Electron, CLI, and non-Capacitor builds. The plugin is
 * lazy-required and the Capacitor-global guard short-circuits
 * before any native call is attempted.
 */

import * as logger from '../../core/logger';
import { isPlainObject } from '../../core/plainObject';
import { isCapacitorNative } from './bridge/capacitorPresence';

import type { AutoVoteBackgroundPlugin, AutoVoteStatus, CapacitorGlobals } from '../../core/types/capacitor';
import { errorMessage } from '../../core/errorMessage';

let pluginInstance: AutoVoteBackgroundPlugin | null = null;
// A build without the plugin is looked at on every call (claim changes ask too): it is said once.
let warnedAbsent = false;
const getPlugin = () => {
    if (!isCapacitorNative()) return null;
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

const getStatus = (): Promise<AutoVoteStatus> => callPlugin('getStatus', false) as Promise<AutoVoteStatus>;

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

/** What a full Stop came to natively: the work was cancelled; the fence holds it (`epoch`) or does not (`reason`). */
type NativeStopFailure = 'unreadable' | 'oversize' | 'not-saved';
type NativeStop = { durable: true; epoch: number } | { durable: false; reason: NativeStopFailure };

const isStopFailure = (value: unknown): value is NativeStopFailure =>
    value === 'unreadable' || value === 'oversize' || value === 'not-saved';

/**
 * A user's full Stop, straight to the native service (AutoVotePlugin.stopAll): its work and alarms are cancelled, then the Stop
 * is recorded in the native priority fence. Null when there is no native plugin (a build without the service). A call that
 * fails, or an answer that is not the plugin's shape, is a Stop that is not durable (`not-saved`): the caller's own local
 * cancellation stands, and the fence is not claimed.
 */
const stopAll = async (requestId: string, at: number): Promise<NativeStop | null> => {
    const plugin = getPlugin();
    if (!plugin) return null;
    try {
        const answer: unknown = await plugin.stopAll({ requestId, at });
        if (!isPlainObject(answer)) return { durable: false, reason: 'not-saved' };
        if (answer.durable === true && typeof answer.epoch === 'number' && Number.isSafeInteger(answer.epoch)) {
            return { durable: true, epoch: answer.epoch };
        }
        return { durable: false, reason: isStopFailure(answer.reason) ? answer.reason : 'not-saved' };
    } catch (err) {
        logger.withCategory('voting').error('AutoVoteBackground.stopAll failed', err);
        return { durable: false, reason: 'not-saved' };
    }
};

export { start, stop, stopAll, getStatus, isAvailable, compareAndWrite };
export type { AutoVoteStatus };
