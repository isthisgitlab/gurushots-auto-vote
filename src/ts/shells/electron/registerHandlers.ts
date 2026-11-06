/**
 * The Electron shell's ipcMain registration for the handler modules (actions, computations,
 * currency, log, misc, scenarios, settings, update, voting). Each module exports
 * buildHandlers(deps) → {channel: impl}; this registers every entry.
 *
 * Registration also adds a sender-frame check as defense-in-depth: the app
 * only ever loads its own file:// pages, so any invoke arriving from a
 * non-main frame or a non-file origin is refused. Nothing untrusted can
 * load, so the check never fires in practice — it exists so a future regression
 * that renders remote content doesn't inherit the full IPC surface.
 * The Logs window is held to a smaller set per sender: its webContents is
 * registered with restrictToLogsChannels() and may then invoke only the
 * manifest's logsWindowInvokeChannels, read only the manifest's logsWindowSettingKeys through get-setting, and be told
 * of a settings change only for those keys. Unit tests and the Capacitor bridge call
 * buildHandlers() directly and are unaffected.
 */

import * as logger from '../../core/logger';
import { logsWindowInvokeChannels, logsWindowSettingKeys } from '../../core/ipc/manifest';
import { isPlainObject } from '../../core/plainObject';
import { invokeHandler } from '../../core/ipc/invokeHandler';

import type { IpcHandler } from '../../core/ipc/invokeHandler';
import type { IpcMain, IpcMainEvent, IpcMainInvokeEvent, WebContents } from 'electron';

/**
 * @param event - Null/undefined on a
 *   direct (non-Electron) invocation, which is trusted. An Electron event is
 *   trusted only when its sending frame is the window's main frame and local.
 */
const isTrustedSender = (event: IpcMainInvokeEvent | IpcMainEvent | null | undefined): boolean => {
    // Direct invocation without an Electron event (CLI, Capacitor, web shell, tests).
    if (!event) return true;
    try {
        // Read senderFrame inside the try: Electron's getter throws when the sending frame
        // has already been disposed (renderer navigated or closed while the message was in
        // flight). Outside the try that propagated as an uncaught exception in the main
        // process — a crash rather than the refusal this function is supposed to fall back to.
        // oxlint-disable-next-line frame-guard/no-unfiltered-frame-send -- reads the sender's frame to check its url; sends nothing
        const frame = event.senderFrame;
        // A real event whose sender cannot be identified is not trusted.
        if (!frame || typeof frame.url !== 'string') return false;
        // oxlint-disable-next-line frame-guard/no-unfiltered-frame-send -- compares the sender's frame with the window's main frame; sends nothing
        if (event.sender?.mainFrame && frame !== event.sender.mainFrame) return false;
        return frame.url.startsWith('file://');
    } catch {
        return false;
    }
};

// Where a refused message came from, for the log. Reading a disposed frame throws.
const senderUrl = (event: IpcMainInvokeEvent): string => {
    try {
        // oxlint-disable-next-line frame-guard/no-unfiltered-frame-send -- reads the sender's frame url for the refusal log; sends nothing
        return event.senderFrame?.url ?? event.sender?.getURL?.() ?? '<unknown>';
    } catch {
        return '<unknown>';
    }
};

// The webContents of windows limited to the Logs channel set. Weak, so a closed window drops out.
const logsWindowSenders = new WeakSet<WebContents>();

// A settings-changed payload cut down to the keys the Logs window may know. The payload is nested
// (`{ app: { language, theme, … }, … }`), so the keys are picked from `app` and nothing else is passed on.
const logsWindowSettings = (payload: unknown): Record<string, unknown> => {
    if (!isPlainObject(payload) || !isPlainObject(payload.app)) return {};
    const { app } = payload;
    return {
        app: Object.fromEntries(
            logsWindowSettingKeys.filter((key) => Object.hasOwn(app, key)).map((key) => [key, app[key]]),
        ),
    };
};

/**
 * Limits every call from this window to the Logs channel set, whatever its preload exposes, and cuts what is sent to
 * it down to what it may know: its settings-changed events carry only the logsWindowSettingKeys. Only
 * `webContents.send` is filtered: `postMessage` and `mainFrame.send` are not, so nothing may use them toward this window
 * (the frame-guard lint rule enforces it over src/ts; the line-level exemptions are pinned in tests/ci-validation.test.ts).
 * @param webContents - the Logs window's, registered before its page loads
 */
const restrictToLogsChannels = (webContents: WebContents): void => {
    logsWindowSenders.add(webContents);
    const send = webContents.send;
    if (typeof send !== 'function') return;
    // oxlint-disable-next-line frame-guard/no-unfiltered-frame-send -- installs the Logs-window channel filter
    webContents.send = (channel: string, ...args: unknown[]) =>
        send.call(webContents, channel, ...(channel === 'settings-changed' ? args.map(logsWindowSettings) : args));
};

/**
 * @param event - Null/undefined on a direct invocation, which is not limited.
 * @param channel - the channel being called (invoke or send)
 */
const isChannelAllowedForSender = (
    event: IpcMainInvokeEvent | IpcMainEvent | null | undefined,
    channel: string,
): boolean =>
    !event?.sender ||
    !logsWindowSenders.has(event.sender) ||
    (logsWindowInvokeChannels as readonly string[]).includes(channel);

/**
 * @param event - Null/undefined on a direct invocation, which is not limited.
 * @param channel - the channel being invoked
 * @param args - the arguments of the call
 */
const isSettingKeyAllowedForSender = (
    event: IpcMainInvokeEvent | null | undefined,
    channel: string,
    args: unknown[],
): boolean =>
    channel !== 'get-setting' ||
    !event?.sender ||
    !logsWindowSenders.has(event.sender) ||
    (logsWindowSettingKeys as readonly unknown[]).includes(args[0]);

const registerHandlers = (ipcMain: IpcMain, handlers: Record<string, IpcHandler>) => {
    for (const [channel, impl] of Object.entries(handlers)) {
        ipcMain.handle(channel, (event, ...args: unknown[]) => {
            if (!isTrustedSender(event)) {
                logger
                    .withCategory('api')
                    .warning(`Refused IPC '${channel}' from untrusted frame ${senderUrl(event)}`, null);
                return { success: false as const, error: 'Refused: untrusted sender' };
            }
            if (!isChannelAllowedForSender(event, channel)) {
                logger.withCategory('api').warning(`Refused IPC '${channel}' from the Logs window`, null);
                return { success: false as const, error: 'Refused: channel not available to this window' };
            }
            if (!isSettingKeyAllowedForSender(event, channel, args)) {
                logger
                    .withCategory('api')
                    .warning(`Refused IPC '${channel}' for a setting the Logs window may not read`, null);
                return { success: false as const, error: 'Refused: setting not available to this window' };
            }
            return invokeHandler(channel, impl, event, args);
        });
    }
};

// isTrustedSender and isChannelAllowedForSender are exported so the handful of channels
// registered with ipcMain.on (which carries no return value, so it cannot go through
// registerHandlers) can apply the same origin and per-window checks instead of silently
// having none.
export { registerHandlers, isTrustedSender, isChannelAllowedForSender, restrictToLogsChannels };
