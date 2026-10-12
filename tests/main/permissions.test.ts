/**
 * src/ts/index/permissions.ts — notifications from the app's own file: pages
 * are the only permission granted, on both the default and the app-window
 * (in-memory) session. The page is judged on webContents.getURL(), never on the origin a
 * check reports (always `file:///` for a file: page).
 */

import type { WebContents } from 'electron';
import type * as permissionsModule from '../../src/ts/index/permissions';
import type * as sessionModule from '../../src/ts/index/session';
import type * as loggerModule from '../../src/ts/logger';
import type { CategoryLogger } from '../../src/ts/logger';
import { invalid } from '../helpers/invalid';

type RequestHandler = (webContents: WebContents, permission: string, callback: (granted: boolean) => void) => void;
type CheckHandler = (webContents: WebContents | null, permission: string, requestingOrigin: string) => boolean;

/** A fake session recording the handlers installed on it. */
function fakeSession() {
    const session = {
        request: null as RequestHandler | null,
        check: null as CheckHandler | null,
        setPermissionRequestHandler: jest.fn((handler: RequestHandler) => {
            session.request = handler;
        }),
        setPermissionCheckHandler: jest.fn((handler: CheckHandler) => {
            session.check = handler;
        }),
    };
    return session;
}

const mockSessions = { default: fakeSession(), appWindow: fakeSession() };

jest.mock('electron', () => ({
    session: {
        defaultSession: mockSessions.default,
        fromPartition: jest.fn((partition: string) =>
            partition === jest.requireActual<typeof sessionModule>('../../src/ts/index/session').APP_PARTITION
                ? mockSessions.appWindow
                : null,
        ),
    },
}));
jest.mock('../../src/ts/logger', () => {
    const cat = { warning: jest.fn() };
    return { withCategory: jest.fn(() => cat), cat };
});

const { installPermissionHandlers } = require('../../src/ts/index/permissions') as typeof permissionsModule;
const cat = jest.mocked((require('../../src/ts/logger') as typeof loggerModule & { cat: CategoryLogger }).cat);

const page = (url: string) => invalid<WebContents>({ getURL: () => url });
const FILE_PAGE = 'file:///app/src/html/app.html';

beforeEach(() => {
    jest.clearAllMocks();
    installPermissionHandlers();
});

it('locks down the partition the app windows use, which is an in-memory one', () => {
    const { APP_PARTITION } = require('../../src/ts/index/session') as typeof sessionModule;
    const { session } = require('electron') as { session: { fromPartition: jest.Mock<unknown, [string]> } };

    expect(session.fromPartition).toHaveBeenCalledWith(APP_PARTITION);
    expect(APP_PARTITION.startsWith('persist:')).toBe(false);
});

describe.each([
    ['the default session', () => mockSessions.default],
    ['the app-window session', () => mockSessions.appWindow],
])('%s', (_name, get) => {
    const session = get;

    it('grants a notifications request from a file: page', () => {
        const callback = jest.fn();
        session().request!(page(FILE_PAGE), 'notifications', callback);

        expect(callback).toHaveBeenCalledWith(true);
        expect(cat.warning).not.toHaveBeenCalled();
    });

    it.each(['media', 'geolocation', 'clipboard-read', 'openExternal'])(
        'denies a %s request and logs it',
        (permission) => {
            const callback = jest.fn();
            session().request!(page(FILE_PAGE), permission, callback);

            expect(callback).toHaveBeenCalledWith(false);
            expect(cat.warning).toHaveBeenCalledWith(
                `Denied permission request '${permission}' from ${FILE_PAGE}`,
                null,
            );
        },
    );

    it('denies notifications requested by a remote page', () => {
        const callback = jest.fn();
        session().request!(page('https://evil.example/'), 'notifications', callback);

        expect(callback).toHaveBeenCalledWith(false);
        expect(cat.warning).toHaveBeenCalledWith(
            "Denied permission request 'notifications' from https://evil.example/",
            null,
        );
    });

    it('allows a notifications check from a file: page whatever origin is reported', () => {
        expect(session().check!(page(FILE_PAGE), 'notifications', 'file:///')).toBe(true);
        expect(cat.warning).not.toHaveBeenCalled();
    });

    it('does not judge a check on its requesting origin', () => {
        expect(session().check!(page('https://evil.example/'), 'notifications', 'file:///')).toBe(false);
        expect(session().check!(page(FILE_PAGE), 'media', 'file:///')).toBe(false);
    });

    it('denies a check with no web contents and logs <unknown>', () => {
        expect(session().check!(null, 'notifications', 'file:///')).toBe(false);
        expect(cat.warning).toHaveBeenCalledWith("Denied permission check 'notifications' from <unknown>", null);
    });
});
