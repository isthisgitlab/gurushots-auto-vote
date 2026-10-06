/**
 * The Discover handlers' identity lookup, against the real member-identity cache: one lookup per
 * token on a cold cache, none on a warm one, and a failed lookup is retried at most every 60 s.
 * (actions.handlers.test.ts mocks the fill module, so it cannot see the cache.)
 */

jest.mock('../../src/ts/settings');
jest.mock('../../src/ts/apiFactory');
jest.mock('../../src/ts/services/auth');
jest.mock('../../src/ts/windows/quitGuard', () => ({ rememberChallenges: jest.fn() }));

import { invalid } from '../helpers/invalid';
import settingsModule = require('../../src/ts/settings');
const settings = jest.mocked(settingsModule);
import apiFactoryModule = require('../../src/ts/apiFactory');
const apiFactory = jest.mocked(apiFactoryModule);
import authModule = require('../../src/ts/services/auth');
const auth = jest.mocked(authModule);
import type * as autoFillModule from '../../src/ts/services/autoFill';
import type * as actionsHandlersModule from '../../src/ts/ipc/actions.handlers';
import type * as openChallengeCacheModule from '../../src/ts/services/openChallengeCache';
import type { Challenge } from '../../src/ts/types/gurushots';
const { __resetMemberIdCache } = require('../../src/ts/services/autoFill') as typeof autoFillModule;
const { buildHandlers } = require('../../src/ts/ipc/actions.handlers') as typeof actionsHandlersModule;
const { clearOpenChallenges } = require('../../src/ts/services/openChallengeCache') as typeof openChallengeCacheModule;

const OWNER = 'member-0';
let getCurrentMemberProfile: jest.MockedFunction<() => Promise<{ id: string } | null>>;

const annotate = () =>
    invalid<(event: unknown, ids: unknown) => Promise<unknown>>(buildHandlers()['get-open-chosen-annotations'])(
        {},
        [7],
    );
const list = () => buildHandlers()['get-member-challenges']({});

beforeEach(() => {
    __resetMemberIdCache();
    clearOpenChallenges();
    getCurrentMemberProfile = jest.fn();
    getCurrentMemberProfile.mockResolvedValue({ id: OWNER });
    apiFactory.getApiStrategy = jest.fn().mockReturnValue({
        getCurrentMemberProfile,
        getMemberChallenges: jest.fn().mockResolvedValue([invalid<Challenge>({ id: 7 })]),
    });
    auth.requireAuthToken = jest.fn().mockReturnValue({ ok: true, token: 'tok', settings: {} });
    jest.mocked(settings.loadSettings).mockReturnValue(invalid({ token: 'tok' }));
    jest.mocked(settings.getSetting).mockReturnValue(invalid(OWNER));
    jest.mocked(settings.getChallengeOverride).mockReturnValue(invalid(['a', 'b']));
    jest.mocked(settings.resolveRuleSetting).mockReturnValue(invalid(null));
    jest.mocked(settings.getEffectiveSetting).mockReturnValue(invalid([]));
});

afterEach(() => {
    jest.restoreAllMocks();
});

describe.each([
    ['get-open-chosen-annotations', annotate],
    ['get-member-challenges', list],
])('%s', (_name, call) => {
    test('a cold cache looks the member up exactly once, however many rows or calls follow', async () => {
        await call();
        expect(getCurrentMemberProfile).toHaveBeenCalledTimes(1);
        expect(getCurrentMemberProfile).toHaveBeenCalledWith('tok');
    });

    test('a warm cache makes no request at all, and the ids come through for the owner', async () => {
        await call();
        getCurrentMemberProfile.mockClear();
        const result = await call();
        expect(getCurrentMemberProfile).not.toHaveBeenCalled();
        expect(JSON.stringify(result)).toContain('"chosenOwn":["a","b"]');
    });

    test('a failed lookup is not repeated for 60 s, then tried again; the ids stay withheld meanwhile', async () => {
        const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
        getCurrentMemberProfile.mockResolvedValue(null);
        const first = await call();
        await call();
        expect(getCurrentMemberProfile).toHaveBeenCalledTimes(1);
        expect(JSON.stringify(first)).toContain('"chosenOwn":[]');
        expect(JSON.stringify(first)).not.toContain('"a"');
        now.mockReturnValue(1_000_000 + 61_000);
        await call();
        expect(getCurrentMemberProfile).toHaveBeenCalledTimes(2);
    });
});
