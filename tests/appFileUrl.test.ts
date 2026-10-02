/**
 * src/ts/appFileUrl.ts — which `file:` URLs count as the app's own pages.
 * Both path flavours are exercised through the `platform` argument with a
 * root in that flavour, so the result does not depend on the host OS.
 */

import type * as appFileUrlModule from '../src/ts/appFileUrl';
import type * as appPathsModule from '../src/ts/appPaths';

jest.mock('../src/ts/appPaths', () => ({ appPath: jest.fn() }));

const { isAppFileUrl } = require('../src/ts/appFileUrl') as typeof appFileUrlModule;
const { appPath } = jest.mocked(require('../src/ts/appPaths') as typeof appPathsModule);

const useRoot = (root: string) =>
    appPath.mockImplementation((...segments) => (segments.join('/') === 'src/html' ? root : ''));

describe('isAppFileUrl (posix)', () => {
    beforeEach(() => useRoot('/opt/My App/Jānis/src/html'));

    test('accepts a page below the html directory, with query and hash', () => {
        expect(isAppFileUrl('file:///opt/My%20App/J%C4%81nis/src/html/app.html', 'linux')).toBe(true);
        expect(isAppFileUrl('file:///opt/My%20App/J%C4%81nis/src/html/app.html?x=1#y', 'darwin')).toBe(true);
        expect(isAppFileUrl('file:///opt/My%20App/J%C4%81nis/src/html/sub/..foo.html', 'linux')).toBe(true);
    });

    test('rejects a path that escapes the html directory', () => {
        expect(isAppFileUrl('file:///opt/My%20App/J%C4%81nis/src/html/../secret.html', 'linux')).toBe(false);
        expect(isAppFileUrl('file:///etc/passwd', 'linux')).toBe(false);
    });

    test('rejects a sibling directory sharing the prefix', () => {
        expect(isAppFileUrl('file:///opt/My%20App/J%C4%81nis/src/html-evil/x.html', 'linux')).toBe(false);
    });

    test('rejects the html directory itself', () => {
        expect(isAppFileUrl('file:///opt/My%20App/J%C4%81nis/src/html', 'linux')).toBe(false);
        expect(isAppFileUrl('file:///opt/My%20App/J%C4%81nis/src/html/', 'linux')).toBe(false);
    });

    test('is case-sensitive', () => {
        expect(isAppFileUrl('file:///opt/my%20app/J%C4%81nis/src/html/app.html', 'linux')).toBe(false);
    });

    test('rejects a file URL with a remote host, non-file URLs and unparsable input', () => {
        expect(isAppFileUrl('file://host/opt/My%20App/J%C4%81nis/src/html/app.html', 'linux')).toBe(false);
        expect(isAppFileUrl('https://example.com/src/html/app.html', 'linux')).toBe(false);
        expect(isAppFileUrl('not a url', 'linux')).toBe(false);
        expect(isAppFileUrl('', 'linux')).toBe(false);
    });

    test('defaults to the host platform', () => {
        const host = process.platform === 'win32' ? 'C:\\app\\src\\html' : '/app/src/html';
        useRoot(host);
        const url = process.platform === 'win32' ? 'file:///C:/app/src/html/a.html' : 'file:///app/src/html/a.html';
        expect(isAppFileUrl(url)).toBe(true);
    });
});

describe('isAppFileUrl (win32)', () => {
    beforeEach(() => useRoot('C:\\Users\\Jānis\\My App\\src\\html'));

    test('accepts a page below the html directory (spaces, non-ASCII)', () => {
        expect(isAppFileUrl('file:///C:/Users/J%C4%81nis/My%20App/src/html/app.html', 'win32')).toBe(true);
    });

    test('ignores drive-letter and path case', () => {
        expect(isAppFileUrl('file:///c:/users/j%C4%81nis/my%20app/SRC/Html/App.html', 'win32')).toBe(true);
    });

    test('rejects another drive', () => {
        expect(isAppFileUrl('file:///D:/Users/J%C4%81nis/My%20App/src/html/app.html', 'win32')).toBe(false);
    });

    test('rejects a UNC share', () => {
        expect(isAppFileUrl('file://host/share/Users/J%C4%81nis/My%20App/src/html/app.html', 'win32')).toBe(false);
    });

    test('rejects a path that escapes the html directory', () => {
        expect(isAppFileUrl('file:///C:/Users/J%C4%81nis/My%20App/src/html/../secret.html', 'win32')).toBe(false);
        expect(isAppFileUrl('file:///C:/Windows/win.ini', 'win32')).toBe(false);
    });

    test('rejects a sibling directory sharing the prefix', () => {
        expect(isAppFileUrl('file:///C:/Users/J%C4%81nis/My%20App/src/html-evil/x.html', 'win32')).toBe(false);
    });

    test('rejects the html directory itself, non-file URLs and unparsable input', () => {
        expect(isAppFileUrl('file:///C:/Users/J%C4%81nis/My%20App/src/html', 'win32')).toBe(false);
        expect(isAppFileUrl('https://example.com/', 'win32')).toBe(false);
        expect(isAppFileUrl('::', 'win32')).toBe(false);
    });
});
