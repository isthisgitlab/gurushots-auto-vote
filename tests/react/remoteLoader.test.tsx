/** The root remote entry launches only the current v2 page. */

import { setRemoteConnectionState } from '../../src/ts/core/remote/connectionState';
import { waitFor } from '@testing-library/preact';

jest.mock('../../src/ts/core/translations/renderer', () => ({
    rendererTranslator: jest.requireActual<typeof import('../../src/ts/core/translations/renderer')>(
        '../../src/ts/core/translations/renderer',
    ).rendererTranslator,
}));

const KEY = 'a'.repeat(43);
let replaceSpy: jest.SpiedFunction<(url: string | URL) => void>;
let navigated: string[];

const load = (): void => {
    jest.isolateModules(() => {
        require('../../src/ts/shells/remote/loader');
    });
};

describe('the current-v2 remote launcher', () => {
    beforeEach(() => {
        document.body.innerHTML = '<div id="root"></div>';
        window.history.replaceState(null, '', `/remote/index.html#k=${KEY}`);
        navigated = [];
        replaceSpy = jest.spyOn(window.location, 'replace').mockImplementation((url: string | URL) => {
            navigated.push(String(url));
        });
        setRemoteConnectionState('connecting');
    });

    afterEach(() => {
        replaceSpy.mockRestore();
        window.history.replaceState(null, '', '/');
        jest.resetModules();
    });

    test('opens only the current v2 page with its key in the fragment', () => {
        load();
        expect(navigated).toEqual([`./v2/index.html#k=${KEY}`]);
    });

    test.each([
        ['/remote/index.html', 'missing key'],
        ['/remote/index.html#k=bad', 'malformed key'],
        [`/remote/index.html#k=${KEY}&k=${KEY}`, 'duplicate key'],
    ])('refuses a %s before navigation', async (path) => {
        window.history.replaceState(null, '', path);
        load();
        expect(navigated).toEqual([]);
        await waitFor(() =>
            expect(document.getElementById('root')?.textContent).toContain('Scan the QR code on your computer to pair'),
        );
    });
});
