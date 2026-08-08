/**
 * Shared ipcMain registration for the handler modules (log, misc, settings,
 * voting, actions, update). Each module exports buildHandlers(deps) →
 * {channel: impl}; this registers every entry, replacing six identical
 * for-of loops.
 *
 * Registration also adds a sender-frame check as defense-in-depth: the app
 * only ever loads its own file:// pages, so any invoke arriving from a
 * non-main frame or a non-file origin is refused. Today nothing untrusted
 * can load, so this changes no behavior — it exists so a future regression
 * that renders remote content doesn't inherit the full IPC surface.
 * Unit tests and the Capacitor bridge call buildHandlers() directly and are
 * unaffected.
 */

const logger = require('../logger');

const isTrustedSender = (event) => {
    const frame = event?.senderFrame;
    // Direct invocation without an Electron event (tests, internal reuse).
    if (!frame) return true;
    try {
        if (event.sender?.mainFrame && frame !== event.sender.mainFrame) return false;
        return typeof frame.url !== 'string' || frame.url.startsWith('file://');
    } catch {
        return false;
    }
};

const registerHandlers = (ipcMain, handlers) => {
    for (const [channel, impl] of Object.entries(handlers)) {
        ipcMain.handle(channel, (event, ...args) => {
            if (!isTrustedSender(event)) {
                logger
                    .withCategory('api')
                    .warning(
                        `Refused IPC '${channel}' from untrusted frame ${event?.senderFrame?.url ?? '<unknown>'}`,
                        null,
                    );
                return { success: false, error: 'Refused: untrusted sender' };
            }
            return impl(event, ...args);
        });
    }
};

module.exports = { registerHandlers };
