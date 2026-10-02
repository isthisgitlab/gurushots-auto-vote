/**
 * src/ts/index/navigationGuard.ts — the window-open and navigation policy
 * applied to every web contents. Electron's app, shell and web contents are
 * recorded fakes; the URL predicates are the real urlSafe gate and a stubbed
 * app-file check.
 */

import type { App, Event, Shell, WebContents, WindowOpenHandlerResponse } from 'electron';
import type * as navigationGuardModule from '../../src/ts/index/navigationGuard';
import type * as appFileUrlModule from '../../src/ts/appFileUrl';
import type * as loggerModule from '../../src/ts/logger';
import type { CategoryLogger } from '../../src/ts/logger';
import { invalid } from '../helpers/invalid';

type NavigationListener = (event: Event, url: string) => void;
type OpenHandler = (details: { url: string }) => WindowOpenHandlerResponse;

jest.mock('../../src/ts/appFileUrl', () => ({ isAppFileUrl: jest.fn() }));
jest.mock('../../src/ts/logger', () => {
    const cat = { info: jest.fn(), warning: jest.fn(), error: jest.fn(), debug: jest.fn() };
    return { withCategory: jest.fn(() => cat), cat };
});

const { register } = require('../../src/ts/index/navigationGuard') as typeof navigationGuardModule;
const isAppFileUrl = jest.mocked((require('../../src/ts/appFileUrl') as typeof appFileUrlModule).isAppFileUrl);
const cat = jest.mocked((require('../../src/ts/logger') as typeof loggerModule & { cat: CategoryLogger }).cat);

const flush = () => new Promise((resolve) => setImmediate(resolve));

/** Registers the guard on a fake app and returns the guarded fake contents plus the shell. */
function setup(currentUrl = 'file:///app/src/html/app.html') {
    let created!: (event: unknown, contents: WebContents) => void;
    const app = invalid<App>({
        on: jest.fn((event: string, listener: typeof created) => {
            if (event === 'web-contents-created') created = listener;
        }),
    });
    const shell = invalid<Shell>({ openExternal: jest.fn(() => Promise.resolve()) });
    const listeners: Record<string, NavigationListener> = {};
    let openHandler!: OpenHandler;
    const contents = invalid<WebContents>({
        getURL: () => currentUrl,
        setWindowOpenHandler: jest.fn((handler: OpenHandler) => {
            openHandler = handler;
        }),
        on: jest.fn((event: string, listener: NavigationListener) => {
            listeners[event] = listener;
        }),
    });
    register(app, shell);
    created(null, contents);
    const openExternal = jest.mocked(shell.openExternal);
    const navigate = (event: 'will-navigate' | 'will-redirect', url: string) => {
        const preventDefault = jest.fn();
        listeners[event](invalid<Event>({ preventDefault }), url);
        return preventDefault;
    };
    return { openExternal, navigate, open: (url: string) => openHandler({ url }) };
}

beforeEach(() => {
    jest.clearAllMocks();
    isAppFileUrl.mockReturnValue(false);
});

describe('window open policy', () => {
    it('denies every window and hands an openable link to the system', () => {
        const { open, openExternal } = setup();

        for (const url of ['https://example.com/a', 'http://example.com/', 'mailto:a@b.co']) {
            expect(open(url)).toEqual({ action: 'deny' });
            expect(openExternal).toHaveBeenCalledWith(url);
        }
        expect(cat.warning).not.toHaveBeenCalled();
    });

    it('denies and logs a link that is not openable, without opening it', () => {
        const { open, openExternal } = setup();

        expect(open('file:///etc/passwd')).toEqual({ action: 'deny' });
        expect(open('https://user:pw@evil.example/')).toEqual({ action: 'deny' });
        expect(openExternal).not.toHaveBeenCalled();
        expect(cat.warning).toHaveBeenCalledWith('Refused window.open to file:///etc/passwd', null);
        expect(cat.warning).toHaveBeenCalledWith('Refused window.open to https://user:pw@evil.example/', null);
    });

    it('logs a failed hand-off to the system', async () => {
        const { open, openExternal } = setup();
        const failure = new Error('no handler');
        openExternal.mockRejectedValueOnce(failure);

        open('https://example.com/');
        await flush();

        expect(cat.error).toHaveBeenCalledWith('Failed to open https://example.com/ externally:', failure);
    });
});

describe.each(['will-navigate', 'will-redirect'] as const)('%s', (event) => {
    it('lets the window reload its current URL', () => {
        const { navigate, openExternal } = setup('https://example.com/now');

        expect(navigate(event, 'https://example.com/now')).not.toHaveBeenCalled();
        expect(openExternal).not.toHaveBeenCalled();
    });

    it("lets the window move to one of the app's own pages", () => {
        isAppFileUrl.mockImplementation((url) => url === 'file:///app/src/html/logs.html');
        const { navigate } = setup();

        expect(navigate(event, 'file:///app/src/html/logs.html')).not.toHaveBeenCalled();
    });

    it('cancels and opens an openable link in the system browser', () => {
        const { navigate, openExternal } = setup();

        expect(navigate(event, 'https://example.com/out')).toHaveBeenCalled();
        expect(openExternal).toHaveBeenCalledWith('https://example.com/out');
    });

    it('cancels and logs anything else, including a dropped local file', () => {
        const { navigate, openExternal } = setup();

        expect(navigate(event, 'file:///Users/me/Downloads/evil.html')).toHaveBeenCalled();
        expect(openExternal).not.toHaveBeenCalled();
        expect(cat.warning).toHaveBeenCalledWith('Refused navigation to file:///Users/me/Downloads/evil.html', null);
    });
});
