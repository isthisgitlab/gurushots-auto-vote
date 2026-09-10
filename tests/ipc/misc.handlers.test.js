/**
 * Guards the security-relevant wiring in misc.handlers: the open-external-url
 * scheme gate. A regression that dropped the isSafeExternalUrl guard, inverted
 * it, or broke the import would otherwise pass the suite unnoticed — the
 * manifest test only collects channel NAMES, it never invokes the handler.
 */

const openExternalMock = jest.fn().mockResolvedValue(undefined);

jest.mock('electron', () => ({
    shell: { openExternal: openExternalMock },
}));
jest.mock('../../src/js/ui/applicationMenu', () => ({
    updateMenuTranslations: jest.fn(),
}));
jest.mock('../../src/js/logger', () => {
    const cat = { warning: jest.fn(), error: jest.fn(), info: jest.fn() };
    return { withCategory: jest.fn(() => cat) };
});

const { buildHandlers } = require('../../src/js/ipc/misc.handlers');

describe('misc.handlers open-external-url scheme gate', () => {
    let handler;
    beforeEach(() => {
        openExternalMock.mockClear();
        handler = buildHandlers({ getMainWindow: jest.fn(), getLoginWindow: jest.fn() })['open-external-url'];
    });

    test('opens a well-formed https URL', async () => {
        const res = await handler({}, 'https://gurushots.com/challenges');
        expect(openExternalMock).toHaveBeenCalledWith('https://gurushots.com/challenges');
        expect(res).toEqual({ success: true });
    });

    test.each([
        ['http (insecure)', 'http://gurushots.com'],
        ['javascript scheme', 'javascript:alert(1)'],
        ['file scheme', 'file:///etc/passwd'],
        ['embedded credentials', 'https://gurushots.com@evil.com/'],
        ['non-string', 42],
        ['empty', ''],
    ])('refuses %s and never calls shell.openExternal', async (_label, url) => {
        const res = await handler({}, url);
        expect(openExternalMock).not.toHaveBeenCalled();
        expect(res.success).toBe(false);
        expect(res.error).toMatch(/https/i);
    });

    test('reports a failure when shell.openExternal throws', async () => {
        openExternalMock.mockRejectedValueOnce(new Error('boom'));
        const res = await handler({}, 'https://example.com');
        expect(res.success).toBe(false);
        expect(res.error).toBe('boom');
    });
});
