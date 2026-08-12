/**
 * isTrustedSender is the app's only IPC sender-origin check, and it had no tests.
 *
 * registerHandlers applies it to every ipcMain.handle channel automatically, so it gates the
 * whole invoke surface — including anything added later. index.js's two ipcMain.on channels
 * ('login-success' and 'logout', the latter clearing the auth token) used to bypass it
 * entirely and now call it directly, which is why it is exported.
 *
 * The rules it encodes:
 *   - no Electron event at all (direct invocation from tests or internal reuse) is trusted
 *   - a frame that is not the window's main frame is refused, so an embedded iframe cannot
 *     drive privileged channels
 *   - the main frame is trusted only when it is local (file://)
 *   - anything that throws while being inspected is refused rather than assumed safe
 */

const { isTrustedSender, registerHandlers } = require('../../src/js/ipc/registerHandlers');

const mainFrame = (url) => {
    const frame = { url };
    return { senderFrame: frame, sender: { mainFrame: frame } };
};

describe('isTrustedSender', () => {
    test('trusts a call with no event (direct invocation)', () => {
        expect(isTrustedSender(undefined)).toBe(true);
        expect(isTrustedSender(null)).toBe(true);
        expect(isTrustedSender({})).toBe(true);
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

        expect(isTrustedSender(event)).toBe(false);
    });

    test('trusts a frame whose url is not a string', () => {
        // Electron can hand back a frame without a usable url; the main-frame identity
        // check above has already done the meaningful work in that case.
        expect(isTrustedSender(mainFrame(undefined))).toBe(true);
    });

    test('refuses when inspecting the frame throws', () => {
        const event = {
            senderFrame: {
                get url() {
                    throw new Error('frame destroyed');
                },
            },
        };

        expect(isTrustedSender(event)).toBe(false);
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

        expect(() => isTrustedSender(event)).not.toThrow();
        expect(isTrustedSender(event)).toBe(false);
    });
});

describe('registerHandlers applies the check to every channel', () => {
    const makeIpcMain = () => {
        const channels = new Map();
        return {
            channels,
            handle: (channel, impl) => channels.set(channel, impl),
        };
    };

    test('refuses an untrusted sender without invoking the handler', async () => {
        const impl = jest.fn(async () => 'sensitive');
        const ipcMain = makeIpcMain();
        registerHandlers(ipcMain, { 'do-thing': impl });

        const result = await ipcMain.channels.get('do-thing')(mainFrame('https://evil.example/'), 'arg');

        expect(impl).not.toHaveBeenCalled();
        expect(result).toEqual({ success: false, error: 'Refused: untrusted sender' });
    });

    test('passes the event and arguments through for a trusted sender', async () => {
        const impl = jest.fn(async () => 'ok');
        const ipcMain = makeIpcMain();
        registerHandlers(ipcMain, { 'do-thing': impl });

        const event = mainFrame('file:///app/index.html');
        const result = await ipcMain.channels.get('do-thing')(event, 'a', 'b');

        expect(impl).toHaveBeenCalledWith(event, 'a', 'b');
        expect(result).toBe('ok');
    });
});
