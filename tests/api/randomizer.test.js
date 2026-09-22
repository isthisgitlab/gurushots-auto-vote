/**
 * Tests for api/randomizer.js — the per-installation randomized iOS header set.
 *
 * Contract pinned here:
 *   - a fresh install (no / incomplete saved headers) generates a full header set
 *     drawn from the published pools and persists it once;
 *   - a complete set on the current app version is returned untouched (no write),
 *     so the "device" stays stable across launches;
 *   - a complete set from an older app version keeps its randomized device values
 *     (model, iOS, Alamofire, language) and only bumps the version fields;
 *   - generateRandomHeaders layers the current token on top as `x-token`.
 */

jest.mock('../../src/js/settings', () => ({
    getSetting: jest.fn(),
    setSetting: jest.fn(),
}));

const settings = require('../../src/js/settings');
const randomizer = require('../../src/js/api/randomizer');

const {
    initializeHeaders,
    generateRandomHeaders,
    IPHONE_MODELS,
    IOS_VERSIONS,
    LANGUAGE_PREFERENCES,
    ALAMOFIRE_VERSIONS,
    CURRENT_APP_VERSION,
    CURRENT_BUILD_NUMBER,
} = randomizer;

const completeHeaders = (overrides = {}) => ({
    host: 'api.gurushots.com',
    accept: '*/*',
    'x-device': 'iPhone',
    'x-requested-with': 'XMLHttpRequest',
    'x-model': 'iPhone 12',
    'accept-language': LANGUAGE_PREFERENCES[2],
    'x-api-version': '20',
    'x-env': 'IOS',
    'user-agent': `GuruShotsIOS/${CURRENT_APP_VERSION} (com.gurushots.app; build:${CURRENT_BUILD_NUMBER}; iOS 16.7.3) Alamofire/5.9.0`,
    'x-app-version': CURRENT_APP_VERSION,
    connection: 'keep-alive',
    'x-brand': 'Apple',
    _version: CURRENT_APP_VERSION,
    ...overrides,
});

let store;

beforeEach(() => {
    jest.clearAllMocks();
    store = {};
    settings.getSetting.mockImplementation((key) => store[key]);
    settings.setSetting.mockImplementation((key, value) => {
        store[key] = value;
        return true;
    });
});

afterEach(() => {
    jest.restoreAllMocks();
});

describe('initializeHeaders — fresh generation', () => {
    test('generates and persists a complete header set when nothing is saved', () => {
        const headers = initializeHeaders();

        expect(settings.setSetting).toHaveBeenCalledTimes(1);
        expect(settings.setSetting).toHaveBeenCalledWith('apiHeaders', headers);
        expect(headers.host).toBe('api.gurushots.com');
        expect(headers['x-device']).toBe('iPhone');
        expect(headers['x-brand']).toBe('Apple');
        expect(headers['x-app-version']).toBe(CURRENT_APP_VERSION);
        expect(headers._version).toBe(CURRENT_APP_VERSION);
        expect(IPHONE_MODELS).toContain(headers['x-model']);
        expect(LANGUAGE_PREFERENCES).toContain(headers['accept-language']);
        expect(Object.keys(headers).length).toBeGreaterThanOrEqual(10);

        const ua = headers['user-agent'];
        expect(ua).toContain(`GuruShotsIOS/${CURRENT_APP_VERSION}`);
        expect(ua).toContain(`build:${CURRENT_BUILD_NUMBER}`);
        expect(IOS_VERSIONS).toContain(ua.match(/iOS ([^)]+)/)[1]);
        expect(ALAMOFIRE_VERSIONS).toContain(ua.match(/Alamofire\/(.+)$/)[1]);
    });

    test('picks pool entries from Math.random (first and last element reachable)', () => {
        jest.spyOn(Math, 'random').mockReturnValue(0);
        const first = initializeHeaders();
        expect(first['x-model']).toBe(IPHONE_MODELS[0]);
        expect(first['accept-language']).toBe(LANGUAGE_PREFERENCES[0]);
        expect(first['user-agent']).toContain(`iOS ${IOS_VERSIONS[0]}`);
        expect(first['user-agent']).toMatch(new RegExp(`Alamofire/${ALAMOFIRE_VERSIONS[0].replace(/\./g, '\\.')}$`));

        store = {};
        Math.random.mockReturnValue(0.9999);
        const last = initializeHeaders();
        expect(last['x-model']).toBe(IPHONE_MODELS[IPHONE_MODELS.length - 1]);
        expect(last['accept-language']).toBe(LANGUAGE_PREFERENCES[LANGUAGE_PREFERENCES.length - 1]);
    });

    test.each([
        ['has fewer than 10 fields', { host: 'api.gurushots.com', 'x-model': 'iPhone 12', 'accept-language': 'en' }],
        ['is missing host', completeHeaders({ host: '' })],
        ['is missing x-model', completeHeaders({ 'x-model': undefined })],
        ['is missing accept-language', completeHeaders({ 'accept-language': null })],
    ])('regenerates when the saved set %s', (_label, saved) => {
        store.apiHeaders = saved;

        const headers = initializeHeaders();

        expect(settings.setSetting).toHaveBeenCalledTimes(1);
        expect(headers.host).toBe('api.gurushots.com');
        expect(IPHONE_MODELS).toContain(headers['x-model']);
        expect(LANGUAGE_PREFERENCES).toContain(headers['accept-language']);
        expect(headers._version).toBe(CURRENT_APP_VERSION);
    });
});

describe('initializeHeaders — existing headers', () => {
    test('returns a complete current-version set unchanged without writing', () => {
        const saved = completeHeaders();
        store.apiHeaders = saved;

        const headers = initializeHeaders();

        expect(headers).toBe(saved);
        expect(settings.setSetting).not.toHaveBeenCalled();
    });

    test('an old-version set keeps its randomized device values and only bumps version fields', () => {
        store.apiHeaders = completeHeaders({
            'user-agent': 'GuruShotsIOS/2.0.0 (com.gurushots.app; build:100; iOS 16.7.4) Alamofire/5.8.1',
            'x-app-version': '2.0.0',
            _version: '2.0.0',
            'x-model': 'iPhone 11',
        });

        const headers = initializeHeaders();

        expect(settings.setSetting).toHaveBeenCalledWith('apiHeaders', headers);
        expect(headers['x-model']).toBe('iPhone 11');
        expect(headers['accept-language']).toBe(LANGUAGE_PREFERENCES[2]);
        expect(headers['x-app-version']).toBe(CURRENT_APP_VERSION);
        expect(headers._version).toBe(CURRENT_APP_VERSION);
        expect(headers['user-agent']).toBe(
            `GuruShotsIOS/${CURRENT_APP_VERSION} (com.gurushots.app; build:${CURRENT_BUILD_NUMBER}; iOS 16.7.4) Alamofire/5.8.1`,
        );
    });

    test('an old-version set with an unparseable user-agent falls back to default iOS/Alamofire', () => {
        store.apiHeaders = completeHeaders({ 'user-agent': 'something-else', _version: '1.0.0' });

        const headers = initializeHeaders();

        expect(headers['user-agent']).toBe(
            `GuruShotsIOS/${CURRENT_APP_VERSION} (com.gurushots.app; build:${CURRENT_BUILD_NUMBER}; iOS 16.7.11) Alamofire/5.10.2`,
        );
        expect(settings.setSetting).toHaveBeenCalledTimes(1);
    });

    test('an old-version set with no user-agent at all also falls back to defaults', () => {
        const saved = completeHeaders({ _version: undefined });
        delete saved['user-agent'];
        store.apiHeaders = saved;

        const headers = initializeHeaders();

        expect(headers['user-agent']).toContain('iOS 16.7.11) Alamofire/5.10.2');
        expect(headers._version).toBe(CURRENT_APP_VERSION);
    });

    test('headers are stable across calls once persisted', () => {
        const first = initializeHeaders();
        const second = initializeHeaders();

        expect(second).toEqual(first);
        expect(settings.setSetting).toHaveBeenCalledTimes(1);
    });
});

describe('generateRandomHeaders', () => {
    test('returns the saved headers with the current token as x-token', () => {
        const saved = completeHeaders();
        store.apiHeaders = saved;

        const headers = generateRandomHeaders('tok-123');

        expect(headers).toEqual({ ...saved, 'x-token': 'tok-123' });
        // The persisted set is never polluted with the session token.
        expect(store.apiHeaders['x-token']).toBeUndefined();
    });

    test('initializes headers first when none are saved', () => {
        const headers = generateRandomHeaders('abc');

        expect(settings.setSetting).toHaveBeenCalledTimes(1);
        expect(headers['x-token']).toBe('abc');
        expect(headers.host).toBe('api.gurushots.com');
    });
});
