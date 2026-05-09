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

const runtime = require('../runtime');
const logger = require('../logger');

let pluginInstance = null;
const getPlugin = () => {
    if (!runtime.isCapacitor()) return null;
    if (pluginInstance) return pluginInstance;
    try {
        const cap = globalThis.Capacitor;
        pluginInstance = cap?.Plugins?.AutoVoteBackground || null;
        if (!pluginInstance) {
            logger.withCategory('voting').warning('AutoVoteBackground plugin not registered on this build');
        }
        return pluginInstance;
    } catch (err) {
        logger.withCategory('voting').warning('NativeAutovoteBridge.getPlugin failed', err.message);
        return null;
    }
};

const start = async () => {
    const plugin = getPlugin();
    if (!plugin) return { running: false, available: false };
    try {
        const result = await plugin.start();
        return { ...result, available: true };
    } catch (err) {
        logger.withCategory('voting').error('AutoVoteBackground.start failed', err);
        return { running: false, available: true, error: err.message };
    }
};

const stop = async () => {
    const plugin = getPlugin();
    if (!plugin) return { running: false, available: false };
    try {
        const result = await plugin.stop();
        return { ...result, available: true };
    } catch (err) {
        logger.withCategory('voting').error('AutoVoteBackground.stop failed', err);
        return { running: false, available: true, error: err.message };
    }
};

const getStatus = async () => {
    const plugin = getPlugin();
    if (!plugin) return { running: false, available: false };
    try {
        const result = await plugin.getStatus();
        return { ...result, available: true };
    } catch (err) {
        return { running: false, available: true, error: err.message };
    }
};

const isAvailable = () => getPlugin() !== null;

module.exports = {
    start,
    stop,
    getStatus,
    isAvailable,
};
