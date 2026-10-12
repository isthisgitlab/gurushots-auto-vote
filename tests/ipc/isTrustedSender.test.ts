/**
 * isTrustedSender is the app's only IPC sender-origin check.
 *
 * registerHandlers applies it to every ipcMain.handle channel automatically, so it gates the
 * whole invoke surface — including anything added later. index.ts's two ipcMain.on channels
 * ('login-success' and 'logout', the latter clearing the auth token) call it directly,
 * which is why it is exported.
 *
 * The rules it encodes:
 *   - no Electron event at all (direct invocation from the CLI, Capacitor, the web shell or
 *     tests) is trusted
 *   - an Electron event whose sending frame is missing, or has no string url, is refused
 *   - a frame that is not the window's main frame is refused, so an embedded iframe cannot
 *     drive privileged channels
 *   - the main frame is trusted only when it is local (file://)
 *   - anything that throws while being inspected is refused rather than assumed safe
 */

import type * as registerHandlersModule from '../../src/ts/ipc/registerHandlers';
import type * as loggerModule from '../../src/ts/logger';
import type { IpcMainInvokeEvent } from 'electron';
import { invalid } from '../helpers/invalid';

const { isTrustedSender, isChannelAllowedForSender, registerHandlers, restrictToLogsChannels } =
    require('../../src/ts/ipc/registerHandlers') as typeof registerHandlersModule;

type ChannelImpl = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

const mainFrame = (url: string | undefined) => {
    const frame = { url };
    return invalid<IpcMainInvokeEvent>({ senderFrame: frame, sender: { mainFrame: frame } });
};

describe('isTrustedSender', () => {
    test('trusts a call with no event (direct invocation)', () => {
        expect(isTrustedSender(undefined)).toBe(true);
        expect(isTrustedSender(null)).toBe(true);
    });

    test('refuses an Electron event without a sending frame', () => {
        expect(isTrustedSender(invalid({}))).toBe(false);
        expect(isTrustedSender(invalid({ senderFrame: null }))).toBe(false);
    });

    test('trusts the main frame when it is local', () => {
        expect(isTrustedSender(mainFrame('file:///app/index.html'))).toBe(true);
    });

    test('refuses the main frame when it is remote', () => {
        expect(isTrustedSender(mainFrame('https://example.com/'))).toBe(false);
        expect(isTrustedSender(mainFrame('http://localhost:3000/'))).toBe(false);
    });

    test('refuses a frame that is not the window main frame', () => {
        // An iframe embedded in the renderer: even a file:// URL must not pass, or an
        // embedded document could drive privileged channels.
        const embedded = { url: 'file:///app/index.html' };
        const event = { senderFrame: embedded, sender: { mainFrame: { url: 'file:///app/index.html' } } };

        expect(isTrustedSender(invalid(event))).toBe(false);
    });

    test('refuses a frame whose url is not a string', () => {
        expect(isTrustedSender(mainFrame(undefined))).toBe(false);
    });

    test('refuses when inspecting the frame throws', () => {
        const event = {
            senderFrame: {
                get url() {
                    throw new Error('frame destroyed');
                },
            },
        };

        expect(isTrustedSender(invalid(event))).toBe(false);
    });

    test('refuses when reading senderFrame itself throws', () => {
        // Electron's senderFrame getter throws once the sending frame is disposed — a
        // renderer that navigated or closed while the message was in flight. That must fail
        // closed, not crash the main process.
        const event = {
            get senderFrame() {
                throw new Error('frame disposed');
            },
        };

        expect(() => isTrustedSender(invalid(event))).not.toThrow();
        expect(isTrustedSender(invalid(event))).toBe(false);
    });
});

describe('registerHandlers applies the check to every channel', () => {
    const makeIpcMain = () => {
        const channels = new Map<string, ChannelImpl>();
        return {
            channels,
            handle: (channel: string, impl: ChannelImpl) => channels.set(channel, impl),
        };
    };

    test('refuses an untrusted sender without invoking the handler', async () => {
        const impl = jest.fn(async () => 'sensitive');
        const ipcMain = makeIpcMain();
        registerHandlers(invalid(ipcMain), { 'do-thing': impl });

        const result = await ipcMain.channels.get('do-thing')!(mainFrame('https://evil.example/'), 'arg');

        expect(impl).not.toHaveBeenCalled();
        expect(result).toEqual({ success: false, error: 'Refused: untrusted sender' });
    });

    test('passes the event and arguments through for a trusted sender', async () => {
        const impl = jest.fn(async () => 'ok');
        const ipcMain = makeIpcMain();
        registerHandlers(invalid(ipcMain), { 'do-thing': impl });

        const event = mainFrame('file:///app/index.html');
        const result = await ipcMain.channels.get('do-thing')!(event, 'a', 'b');

        expect(impl).toHaveBeenCalledWith(event, 'a', 'b');
        expect(result).toBe('ok');
    });
});

describe('registerHandlers holds the Logs window to the Logs channel set', () => {
    const logsSender = invalid<IpcMainInvokeEvent['sender']>({});
    const frame = { url: 'file:///app/logs.html' };
    const eventFrom = (sender: unknown) =>
        invalid<IpcMainInvokeEvent>({
            senderFrame: frame,
            sender: Object.assign(sender as object, { mainFrame: frame }),
        });

    const setup = () => {
        const channels = new Map<string, ChannelImpl>();
        const impls = { 'get-log-backlog': jest.fn(async () => 'logs'), 'save-settings': jest.fn(async () => 'saved') };
        registerHandlers(invalid({ handle: (channel: string, fn: ChannelImpl) => channels.set(channel, fn) }), impls);
        restrictToLogsChannels(invalid(logsSender));
        return { channels, impls };
    };

    test('a Logs-window call to a channel in the set reaches its handler', async () => {
        const { channels, impls } = setup();
        const event = eventFrom(logsSender);

        expect(await channels.get('get-log-backlog')!(event)).toBe('logs');
        expect(impls['get-log-backlog']).toHaveBeenCalledWith(event);
    });

    test('a Logs-window call outside the set gets the failure envelope, never the handler', async () => {
        const { channels, impls } = setup();

        const result = await channels.get('save-settings')!(eventFrom(logsSender), { language: 'lv' });

        expect(impls['save-settings']).not.toHaveBeenCalled();
        expect(result).toEqual({ success: false, error: 'Refused: channel not available to this window' });
    });

    test('another window and a direct call are not limited', async () => {
        const { channels, impls } = setup();

        expect(await channels.get('save-settings')!(eventFrom({}))).toBe('saved');
        expect(await channels.get('save-settings')!(invalid(null))).toBe('saved');
        expect(impls['save-settings']).toHaveBeenCalledTimes(2);
    });

    test('the same rule covers the send channels registered with ipcMain.on', () => {
        setup();

        expect(isChannelAllowedForSender(eventFrom(logsSender), 'login-success')).toBe(false);
        expect(isChannelAllowedForSender(eventFrom(logsSender), 'logout')).toBe(false);
        expect(isChannelAllowedForSender(eventFrom(logsSender), 'get-log-backlog')).toBe(true);
        expect(isChannelAllowedForSender(eventFrom({}), 'logout')).toBe(true);
        expect(isChannelAllowedForSender(undefined, 'logout')).toBe(true);
    });

    test('get-setting from the Logs window answers only the language', async () => {
        const channels = new Map<string, ChannelImpl>();
        const getSetting = jest.fn(async (_event: unknown, key: string) => `value of ${key}`);
        registerHandlers(invalid({ handle: (channel: string, fn: ChannelImpl) => channels.set(channel, fn) }), {
            'get-setting': getSetting,
        });
        const sender = invalid<IpcMainInvokeEvent['sender']>({});
        restrictToLogsChannels(invalid(sender));

        expect(await channels.get('get-setting')!(eventFrom(sender), 'language')).toBe('value of language');
        for (const key of ['theme', 'token', 'autovoteRunning', undefined]) {
            expect(await channels.get('get-setting')!(eventFrom(sender), key)).toEqual({
                success: false,
                error: 'Refused: setting not available to this window',
            });
        }
        expect(getSetting).toHaveBeenCalledTimes(1);
        // Every other window and a direct call read any key.
        expect(await channels.get('get-setting')!(eventFrom({}), 'token')).toBe('value of token');
        expect(await channels.get('get-setting')!(invalid(null), 'theme')).toBe('value of theme');
    });

    test('settings-changed sent to the Logs window carries only the language', () => {
        const send = jest.fn<void, [string, ...unknown[]]>();
        const sender = invalid<IpcMainInvokeEvent['sender']>({ send });
        restrictToLogsChannels(invalid(sender));

        sender.send('settings-changed', { language: 'lv', token: 'secret', mock: true, theme: 'dark' });
        sender.send('settings-changed', 'not an object');
        sender.send('log-message', { seq: 1, message: 'a log line', token: 'kept: not a settings event' });

        expect(send).toHaveBeenNthCalledWith(1, 'settings-changed', { language: 'lv' });
        expect(send).toHaveBeenNthCalledWith(2, 'settings-changed', {});
        expect(send).toHaveBeenNthCalledWith(3, 'log-message', {
            seq: 1,
            message: 'a log line',
            token: 'kept: not a settings event',
        });
    });

    test('a window sending settings-changed is not touched until it is restricted', () => {
        const send = jest.fn<void, [string, ...unknown[]]>();
        const sender = invalid<IpcMainInvokeEvent['sender']>({ send });

        sender.send('settings-changed', { language: 'lv', token: 'secret' });

        expect(send).toHaveBeenCalledWith('settings-changed', { language: 'lv', token: 'secret' });
    });

    test('a refusal is logged with the channel', async () => {
        const { channels } = setup();
        const logger = jest.mocked(require('../../src/ts/logger') as typeof loggerModule);
        const warning = jest.fn<void, [string, unknown]>();
        const originalImpl = logger.withCategory.getMockImplementation();
        logger.withCategory.mockImplementation(() => invalid({ warning }));
        try {
            await channels.get('save-settings')!(eventFrom(logsSender));
            expect(warning).toHaveBeenCalledWith("Refused IPC 'save-settings' from the Logs window", null);
        } finally {
            logger.withCategory.mockImplementation(originalImpl);
        }
    });
});

describe('registerHandlers refusal logging', () => {
    const channelFor = (warning: jest.Mock<void, [string, unknown]>) => {
        const logger = jest.mocked(require('../../src/ts/logger') as typeof loggerModule);
        const originalImpl = logger.withCategory.getMockImplementation();
        logger.withCategory.mockImplementation(() => invalid({ warning }));
        const channels = new Map<string, ChannelImpl>();
        registerHandlers(invalid({ handle: (channel: string, fn: ChannelImpl) => channels.set(channel, fn) }), {
            'do-thing': jest.fn(),
        });
        return { run: channels.get('do-thing')!, restore: () => logger.withCategory.mockImplementation(originalImpl) };
    };

    test('logs the sender url of a refused main frame', async () => {
        const warning = jest.fn<void, [string, unknown]>();
        const { run, restore } = channelFor(warning);
        try {
            await run(mainFrame('https://evil.example/page'));
            expect(warning).toHaveBeenCalledWith(
                "Refused IPC 'do-thing' from untrusted frame https://evil.example/page",
                null,
            );
        } finally {
            restore();
        }
    });

    test('logs the webContents url when the event has no sending frame', async () => {
        const warning = jest.fn<void, [string, unknown]>();
        const { run, restore } = channelFor(warning);
        try {
            await run(invalid({ sender: { getURL: () => 'file:///other.html' } }));
            expect(warning).toHaveBeenCalledWith(
                "Refused IPC 'do-thing' from untrusted frame file:///other.html",
                null,
            );
        } finally {
            restore();
        }
    });

    test('still refuses and logs <unknown> when reading the sender throws', async () => {
        const warning = jest.fn<void, [string, unknown]>();
        const { run, restore } = channelFor(warning);
        try {
            const event = {
                get senderFrame() {
                    throw new Error('frame disposed');
                },
            };
            const result = await run(invalid(event));
            expect(result).toEqual({ success: false, error: 'Refused: untrusted sender' });
            expect(warning).toHaveBeenCalledWith("Refused IPC 'do-thing' from untrusted frame <unknown>", null);
        } finally {
            restore();
        }
    });

    test('refuses a non-main frame that has no url (logged as <unknown>)', async () => {
        const logger = jest.mocked(require('../../src/ts/logger') as typeof loggerModule);
        const warning = jest.fn<void, [string, unknown]>();
        // Swap (then restore) the setup-mock implementation rather than spyOn +
        // mockRestore, which would strip it for every later test.
        const originalImpl = logger.withCategory.getMockImplementation();
        logger.withCategory.mockImplementation(() => invalid({ warning }));
        try {
            const channels = new Map<string, ChannelImpl>();
            const impl = jest.fn();
            registerHandlers(invalid({ handle: (channel: string, fn: ChannelImpl) => channels.set(channel, fn) }), {
                'do-thing': impl,
            });

            const event = { senderFrame: {}, sender: { mainFrame: { url: 'file:///app/index.html' } } };
            const result = await channels.get('do-thing')!(invalid(event));

            expect(result).toEqual({ success: false, error: 'Refused: untrusted sender' });
            expect(impl).not.toHaveBeenCalled();
            expect(warning).toHaveBeenCalledWith("Refused IPC 'do-thing' from untrusted frame <unknown>", null);
        } finally {
            logger.withCategory.mockImplementation(originalImpl);
        }
    });
});
