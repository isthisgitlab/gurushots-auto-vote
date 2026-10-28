/**
 * search-photo-tags: the picker's search-box tag suggestions — argument
 * validation, the server's own 3-character minimum, the auth and member
 * guards, the tag filter, its own throttle (a newer term replaces one that
 * waits), and mock mode's substring answer.
 */

jest.mock('../../src/ts/settings');
jest.mock('../../src/ts/apiFactory');
jest.mock('../../src/ts/services/auth');
jest.mock('../../src/ts/services/autoFill');

import settingsModule = require('../../src/ts/settings');
const settings = jest.mocked(settingsModule);
import apiFactoryModule = require('../../src/ts/apiFactory');
const apiFactory = jest.mocked(apiFactoryModule);
import authModule = require('../../src/ts/services/auth');
const auth = jest.mocked(authModule);
import autoFillModule = require('../../src/ts/services/autoFill');
const autoFill = jest.mocked(autoFillModule);
import type * as libraryModule from '../../src/ts/ipc/actions/library';
import type * as mockTagsModule from '../../src/ts/mock/endpoints/tags';
import { invalid } from '../helpers/invalid';
import { logCategories } from '../helpers/logCategories';

const { handleSearchPhotoTags, __resetLibraryThrottle, TAG_THROTTLE_MS } =
    require('../../src/ts/ipc/actions/library') as typeof libraryModule;

// The handler is invoked the way ipcMain does: the event first.
const call = (...args: unknown[]) =>
    (handleSearchPhotoTags as (...a: unknown[]) => ReturnType<typeof handleSearchPhotoTags>)({}, ...args);

type Autocomplete = jest.Mock<Promise<Array<string>>, [string, string, string]>;
type AutocompleteFn = (token: string, term: string, memberId: string) => Promise<Array<string>>;

const newAutocomplete = (result: Array<string> = []): Autocomplete =>
    jest.fn<Promise<Array<string>>, [string, string, string]>(async () => result);

const stubStrategy = (over: { searchTagAutocomplete?: AutocompleteFn } = {}) => {
    const strategy = {
        getCurrentMemberProfile: jest.fn(),
        searchTagAutocomplete: over.searchTagAutocomplete ?? newAutocomplete(),
    };
    apiFactory.getApiStrategy = jest.fn().mockReturnValue(strategy);
    return strategy;
};

const deferred = <T>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => (resolve = r));
    return { promise, resolve };
};

beforeEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
    __resetLibraryThrottle();
    auth.requireAuthToken = jest.fn().mockReturnValue({ ok: true, token: 'tok', settings: {} });
    autoFill.resolveMemberId = jest.fn().mockResolvedValue('member-1');
    settings.getOpenChallengeIds = jest.fn().mockReturnValue(null);
    settings.getSetting = jest.fn().mockReturnValue('tok');
});

describe('validation', () => {
    test.each([[invalid<string>(7)], [null], [{}], [undefined]])(
        'refuses a term that is not text (%p) before looking up the token',
        async (term) => {
            const strategy = stubStrategy();
            await expect(call(term)).resolves.toEqual({ success: false, error: 'invalid-args' });
            expect(auth.requireAuthToken).not.toHaveBeenCalled();
            expect(strategy.searchTagAutocomplete).not.toHaveBeenCalled();
            expect(logCategories('warning', 'Refused search-photo-tags: invalid id argument', null)).toEqual([
                'autoSubmit',
            ]);
        },
    );

    test('two characters make no request at all; three do', async () => {
        const strategy = stubStrategy();
        await expect(call('ab')).resolves.toEqual({ success: true, tags: [] });
        expect(auth.requireAuthToken).not.toHaveBeenCalled();
        expect(autoFill.resolveMemberId).not.toHaveBeenCalled();
        expect(strategy.searchTagAutocomplete).not.toHaveBeenCalled();
        __resetLibraryThrottle();
        await expect(call('flo')).resolves.toMatchObject({ success: true });
        expect(strategy.searchTagAutocomplete).toHaveBeenCalledTimes(1);
    });

    test('a term nothing is left of makes no request either', async () => {
        const strategy = stubStrategy();
        await expect(call('  \u0007 ')).resolves.toEqual({ success: true, tags: [] });
        expect(strategy.searchTagAutocomplete).not.toHaveBeenCalled();
    });

    test('answers the auth guard when signed out', async () => {
        auth.requireAuthToken = jest
            .fn()
            .mockReturnValue({ ok: false, response: { success: false, error: 'No token' } });
        const strategy = stubStrategy();
        await expect(call('flo')).resolves.toEqual({ success: false, error: 'No token' });
        expect(strategy.searchTagAutocomplete).not.toHaveBeenCalled();
    });

    test('an unknown member answers no tags without a request', async () => {
        const strategy = stubStrategy();
        autoFill.resolveMemberId = jest.fn().mockResolvedValue(null);
        await expect(call('flo')).resolves.toEqual({ success: true, tags: [] });
        expect(strategy.searchTagAutocomplete).not.toHaveBeenCalled();
    });
});

describe('the answer', () => {
    test('answers the matching tags, read through the member identity', async () => {
        const strategy = stubStrategy({ searchTagAutocomplete: newAutocomplete(['staircase']) });
        await expect(call('stair')).resolves.toEqual({ success: true, tags: ['staircase'] });
        expect(strategy.searchTagAutocomplete).toHaveBeenCalledWith('tok', 'stair', 'member-1');
        expect(autoFill.resolveMemberId).toHaveBeenCalledWith(
            'tok',
            strategy.getCurrentMemberProfile,
            expect.anything(),
            'library',
        );
    });

    test('drops invisibles whole, over-length tags and duplicates, and keeps the rest in order', async () => {
        const plain = 'garden';
        const atCap = 'b'.repeat(50);
        stubStrategy({
            searchTagAutocomplete: newAutocomplete([
                plain,
                'stair‍case', // a ZWJ (\p{Cf}): dropped whole, not stripped
                'bell\u0007', // a control character (\p{Cc})
                atCap, // exactly MAX_TAG_LENGTH passes
                `${atCap}x`, // one over it: a click would search the cut tag and miss
                plain, // duplicate
                atCap, // duplicate of a kept one
            ]),
        });
        await expect(call('gar')).resolves.toEqual({ success: true, tags: [plain, atCap] });
    });

    test('a failing read is an error result, never a throw', async () => {
        stubStrategy({ searchTagAutocomplete: newAutocomplete().mockRejectedValue(new Error('autocomplete down')) });
        await expect(call('flo')).resolves.toEqual({ success: false, error: 'autocomplete down' });
        stubStrategy({ searchTagAutocomplete: newAutocomplete().mockRejectedValue(new Error('')) });
        __resetLibraryThrottle();
        await expect(call('flo')).resolves.toEqual({ success: false, error: 'Failed to look up matching tags' });
    });
});

describe('the throttle', () => {
    test('a newer term replaces one waiting in the gap: the replaced call answers superseded', async () => {
        jest.useFakeTimers();
        const first = deferred<Array<string>>();
        const autocomplete = newAutocomplete().mockReturnValueOnce(first.promise).mockResolvedValue(['flower']);
        stubStrategy({ searchTagAutocomplete: autocomplete });
        const running = call('flo');
        const early = call('flow');
        const newer = call('flowers');
        await expect(early).resolves.toEqual({ success: false, error: 'superseded' });
        expect(autocomplete).toHaveBeenCalledTimes(1);
        first.resolve(['flower']);
        await expect(running).resolves.toMatchObject({ success: true });
        await jest.advanceTimersByTimeAsync(TAG_THROTTLE_MS);
        await expect(newer).resolves.toMatchObject({ success: true });
        expect(autocomplete.mock.calls[1][1]).toBe('flowers');
    });

    test('calls spaced past the minimum gap both run', async () => {
        jest.useFakeTimers();
        const autocomplete = jest.fn<Promise<Array<string>>, [string, string, string]>(async (_token, term) => [term]);
        stubStrategy({ searchTagAutocomplete: autocomplete });
        await expect(call('flo')).resolves.toEqual({ success: true, tags: ['flo'] });
        await jest.advanceTimersByTimeAsync(TAG_THROTTLE_MS);
        await expect(call('stair')).resolves.toEqual({ success: true, tags: ['stair'] });
        expect(autocomplete).toHaveBeenCalledTimes(2);
    });
});

describe('mock mode', () => {
    test('the mock autocomplete answers the library tags that contain the term: flo -> flower', async () => {
        const mockTags = require('../../src/ts/mock/endpoints/tags') as typeof mockTagsModule;
        stubStrategy({ searchTagAutocomplete: mockTags.searchTagAutocomplete });
        await expect(call('flo')).resolves.toEqual({ success: true, tags: ['flower'] });
    });
});
