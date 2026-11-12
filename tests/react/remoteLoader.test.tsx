/** The root loader routes only by its pairing URL and bounds versioned-page returns per tab. */

import { setRemoteConnectionState } from '../../src/ts/core/remote/connectionState';

jest.mock('../../src/ts/core/translations/renderer', () => ({
    rendererTranslator: jest.requireActual<typeof import('../../src/ts/core/translations/renderer')>(
        '../../src/ts/core/translations/renderer',
    ).rendererTranslator,
}));

const skip = { value: null as { key: string; linkVersion: number } | null, clears: 0 };
jest.mock('../../src/ts/core/remote/linkVersion', () => ({
    skippedTo: (target: { key: string; linkVersion: number }) =>
        skip.value?.key === target.key && skip.value.linkVersion === target.linkVersion,
    markSkippedTo: (target: { key: string; linkVersion: number }) => {
        skip.value = target;
    },
    clearSkipMark: () => {
        skip.value = null;
        skip.clears += 1;
    },
}));

const KEY = 'a'.repeat(43);
const OTHER_KEY = 'b'.repeat(43);
const g = globalThis as { fetch?: typeof fetch };
let replaceSpy: jest.SpiedFunction<(url: string | URL) => void>;
let navigated: string[];

const load = (native = false): void => {
    jest.isolateModules(() => {
        if (native) {
            const phoneMode =
                require('../../src/ts/core/remote/phoneMode') as typeof import('../../src/ts/core/remote/phoneMode');
            phoneMode.installPhoneRemoteMode({ disconnect: async () => undefined });
        }
        require('../../src/ts/shells/remote/loader');
    });
};

const flush = async (): Promise<void> => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

describe('the URL-authoritative remote loader', () => {
    beforeEach(() => {
        document.body.innerHTML = '<div id="root"></div>';
        window.history.replaceState(null, '', `/remote/index.html#k=${KEY}`);
        window.sessionStorage.clear();
        skip.value = null;
        skip.clears = 0;
        navigated = [];
        replaceSpy = jest.spyOn(window.location, 'replace').mockImplementation((url: string | URL) => {
            navigated.push(String(url));
        });
        g.fetch = jest.fn(async () => ({ status: 200 }) as Response);
        setRemoteConnectionState('connecting');
    });

    afterEach(() => {
        replaceSpy.mockRestore();
        delete g.fetch;
        window.history.replaceState(null, '', '/');
        jest.resetModules();
    });

    test('routes an unversioned URL directly to released v1 without a probe or current transport discovery', async () => {
        load();
        await flush();
        expect(navigated).toEqual([`./v1/index.html#k=${KEY}`]);
        expect(g.fetch).not.toHaveBeenCalled();
        expect(skip.value).toEqual({ key: KEY, linkVersion: 1 });
    });

    test('shows the offline notice when navigation throws at the route boundary', async () => {
        replaceSpy.mockImplementation(() => {
            throw new Error('navigation refused');
        });
        load();
        await flush();
        expect(document.getElementById('root')?.textContent).toContain(
            'Your computer is offline, or this link was reset.',
        );
    });

    test('routes an explicit v2 URL after a non-missing probe response', async () => {
        window.history.replaceState(null, '', `/remote/index.html#k=${KEY}&v=2`);
        load();
        await flush();
        expect(g.fetch).toHaveBeenCalledWith('./v2/index.html', { method: 'HEAD' });
        expect(navigated).toEqual([`./v2/index.html#k=${KEY}&v=2`]);
    });

    test('does not let a marked key block another key at the same version', async () => {
        skip.value = { key: KEY, linkVersion: 1 };
        window.history.replaceState(null, '', `/remote/index.html#k=${OTHER_KEY}`);
        load();
        await flush();
        expect(navigated).toEqual([`./v1/index.html#k=${OTHER_KEY}`]);
        expect(skip.value).toEqual({ key: OTHER_KEY, linkVersion: 1 });
    });

    test('does not let a marked version block another checked version of the same key', async () => {
        skip.value = { key: KEY, linkVersion: 1 };
        window.history.replaceState(null, '', `/remote/index.html#k=${KEY}&v=2`);
        load();
        await flush();
        expect(navigated).toEqual([`./v2/index.html#k=${KEY}&v=2`]);
        expect(skip.value).toEqual({ key: KEY, linkVersion: 2 });
    });

    test.each([404, 410])('shows unpublished only when HEAD definitively reports %i', async (status) => {
        window.history.replaceState(null, '', `/remote/index.html#k=${KEY}&v=2`);
        g.fetch = jest.fn(async () => ({ status }) as Response);
        load();
        await flush();
        expect(navigated).toEqual([]);
        expect(document.getElementById('root')?.textContent).toContain('not published yet');
    });

    test.each([405, 503])('tries only the selected page when HEAD answers %i', async (status) => {
        window.history.replaceState(null, '', `/remote/index.html#k=${KEY}&v=2`);
        g.fetch = jest.fn(async () => ({ status }) as Response);
        load();
        await flush();
        expect(navigated).toEqual([`./v2/index.html#k=${KEY}&v=2`]);
    });

    test('tries only the selected page when HEAD fails', async () => {
        window.history.replaceState(null, '', `/remote/index.html#k=${KEY}&v=2`);
        g.fetch = jest.fn(async () => Promise.reject(new Error('offline')));
        load();
        await flush();
        expect(navigated).toEqual([`./v2/index.html#k=${KEY}&v=2`]);
    });

    test('restores a kept key only by adding it to the actual loader URL', async () => {
        window.history.replaceState(null, '', '/remote/index.html');
        window.sessionStorage.setItem('remote-pairing-key', KEY);
        load();
        await flush();
        expect(navigated).toEqual([`./v1/index.html#k=${KEY}`]);
    });

    test('shows the no-key notice when a loader URL and this tab have no key', async () => {
        window.history.replaceState(null, '', '/remote/index.html');
        load();
        await flush();
        expect(navigated).toEqual([]);
        expect(document.getElementById('root')?.textContent).toContain('Scan the QR code on your computer to pair');
    });

    test.each([
        ['/other/index.html', 'an unrelated path'],
        [`/remote/index.html#k=bad`, 'malformed provided metadata'],
    ])('does not replace %s with a kept key when it has %s', async (path, _reason) => {
        window.history.replaceState(null, '', path);
        window.sessionStorage.setItem('remote-pairing-key', KEY);
        load();
        await flush();
        expect(navigated).toEqual([]);
        expect(document.getElementById('root')?.textContent).toContain('Scan the QR code on your computer to pair');
    });

    test.each([
        [
            1,
            'This link uses an older remote page. Copy a new link from your computer. Update the computer app if needed.',
        ],
        [3, 'This link needs a newer app on your phone. Update this app, then paste the link again.'],
    ])(
        'shows the complete native stored-target notice for v%i before probing or navigating',
        async (linkVersion, message) => {
            window.history.replaceState(null, '', `/remote/index.html#k=${KEY}&v=${linkVersion}`);
            load(true);
            await flush();
            expect(g.fetch).not.toHaveBeenCalled();
            expect(navigated).toEqual([]);
            expect(document.getElementById('root')?.textContent).toContain(message);
            expect(document.getElementById('root')?.textContent).toContain('Disconnect');
        },
    );

    test('shows update-this when the matching native page is missing', async () => {
        window.history.replaceState(null, '', `/remote/index.html#k=${KEY}&v=2`);
        g.fetch = jest.fn(async () => ({ status: 404 }) as Response);
        load(true);
        await flush();
        expect(navigated).toEqual([]);
        expect(document.getElementById('root')?.textContent).toContain('Update this app');
    });

    test('bounds a script-driven return and provides relink guidance', async () => {
        skip.value = { key: KEY, linkVersion: 1 };
        load();
        await flush();
        expect(navigated).toEqual([]);
        expect(skip.value).toBeNull();
        expect(document.getElementById('root')?.textContent).toContain('Copy the current remote link');
    });

    test.each(['reload', 'back_forward'] as const)('retries after a modern %s navigation', async (type) => {
        skip.value = { key: KEY, linkVersion: 1 };
        jest.spyOn(performance, 'getEntriesByType').mockReturnValue([{ type }] as unknown as PerformanceEntryList);
        load();
        await flush();
        expect(navigated).toEqual([`./v1/index.html#k=${KEY}`]);
        expect(skip.clears).toBe(1);
    });

    test.each([1, 2])('retries after legacy navigation type %i when no modern entry exists', async (type) => {
        skip.value = { key: KEY, linkVersion: 1 };
        jest.spyOn(performance, 'getEntriesByType').mockReturnValue([]);
        Object.defineProperty(performance, 'navigation', { configurable: true, value: { type } });
        load();
        await flush();
        expect(navigated).toEqual([`./v1/index.html#k=${KEY}`]);
    });
});
