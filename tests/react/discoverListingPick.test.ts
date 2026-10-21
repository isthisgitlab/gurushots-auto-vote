/**
 * The Discover listing's explicit field pick (`handleGetMemberChallenges`): the rows that cross IPC
 * carry only what Discover, the CLI's `discover` and the join paths read — never another server field
 * (`guru_info`, the member's ranking payload, …) — plus each challenge's suggested photo ids from the
 * strategy's in-memory cache, whose failure must not break the listing.
 */

jest.mock('../../src/ts/settings');
jest.mock('../../src/ts/apiFactory');
jest.mock('../../src/ts/services/auth');
jest.mock('../../src/ts/services/autoFill');

import { handleGetMemberChallenges } from '../../src/ts/ipc/actions/account';
import { clearUpcomingCache } from '../../src/ts/services/discoverChallenges';
import { invalid } from '../helpers/invalid';

import settingsModule = require('../../src/ts/settings');
import apiFactoryModule = require('../../src/ts/apiFactory');
import authModule = require('../../src/ts/services/auth');
import autoFillModule = require('../../src/ts/services/autoFill');
import type { OpenChallenge } from '../../src/ts/types/gurushots';
import type * as apiFactoryType from '../../src/ts/apiFactory';

const settings = jest.mocked(settingsModule);
const apiFactory = jest.mocked(apiFactoryModule);
const auth = jest.mocked(authModule);
const autoFill = jest.mocked(autoFillModule);

const NOW = 1_800_000_000;

type Strategy = ReturnType<(typeof apiFactoryType)['getApiStrategy']>;

const stubStrategy = (
    lists: (filter: string) => unknown,
    suggested: jest.MockedFunction<(token: string, id: string) => Promise<string[]>>,
) => {
    const strategy = {
        getMemberChallenges: jest.fn(async (_token: string, filter: string) => lists(filter)),
        getSuggestedPhotoIds: suggested,
    };
    apiFactory.getApiStrategy.mockReturnValue(strategy as unknown as Strategy);
    return strategy;
};

const listItems = async (): Promise<OpenChallenge[]> => {
    const result = await handleGetMemberChallenges();
    if (!result.success) throw new Error(result.error ?? 'the listing failed');
    return result.items;
};

beforeEach(() => {
    jest.clearAllMocks();
    // The upcoming list is cached for a minute per token: every test starts without it.
    clearUpcomingCache();
    auth.requireAuthToken.mockReturnValue(invalid({ ok: true as const, token: 'tok', settings: {} }));
    settings.getEffectiveSetting.mockImplementation(
        invalid((key: string) => (key === 'discoverUpcomingHours' ? 24 : [])),
    );
    settings.getSetting.mockReturnValue(invalid(''));
    settings.getChallengeOverride.mockReturnValue(invalid(null));
    settings.resolveRuleSetting.mockReturnValue(invalid(null));
    settings.getUpcomingChallengeIds.mockReturnValue(invalid([]));
    autoFill.peekMemberId.mockReturnValue('member-1');
    jest.spyOn(Date, 'now').mockReturnValue(NOW * 1000);
});

afterEach(() => jest.mocked(Date.now).mockRestore());

describe('get-member-challenges — the row pick', () => {
    test('a listing item crosses IPC as the picked fields alone, with the ids GuruShots suggested', async () => {
        const suggested = jest.fn(async (_token: string, _id: string) => ['a'.repeat(32), 'b'.repeat(32)]);
        stubStrategy(
            (filter) =>
                filter === 'open'
                    ? [
                          {
                              id: 7,
                              title: 'Sunset',
                              url: 'sunset',
                              type: 'default',
                              badge: '',
                              tags: ['Comm'],
                              start_time: NOW - 10,
                              close_time: NOW + 100,
                              entries: 12,
                              players: 34,
                              max_players: 150,
                              votes: 5678,
                              join_coins: 0,
                              max_photo_submits: 3,
                              first_prizes: [{ type: 'KEY', amount: 1 }],
                              member: { submit_state: 'OPEN', ranking: { total: { votes: 9 } } },
                              guru_info: { id: 'g', title: 'server only' },
                              welcome_message: '<script>never</script>',
                          },
                      ]
                    : [],
            suggested,
        );

        const items = await listItems();

        expect(items).toHaveLength(1);
        // toEqual is exact: any server field outside the pick (guru_info, welcome_message, the
        // member's ranking payload) fails here.
        expect(items[0]).toEqual({
            id: 7,
            title: 'Sunset',
            url: 'sunset',
            type: 'default',
            badge: '',
            tags: ['Comm'],
            start_time: NOW - 10,
            close_time: NOW + 100,
            entries: 12,
            players: 34,
            max_players: 150,
            votes: 5678,
            join_coins: 0,
            max_photo_submits: 3,
            first_prizes: [{ type: 'KEY', amount: 1 }],
            member: { submit_state: 'OPEN' },
            suggestedPhotoIds: ['a'.repeat(32), 'b'.repeat(32)],
            chosenOwn: [],
            chosenOwnCount: 0,
            chosenEffectiveCount: 0,
        });
        expect(suggested).toHaveBeenCalledWith('tok', '7');
        expect(JSON.stringify(items)).not.toContain('guru_info');
        expect(JSON.stringify(items)).not.toContain('server only');
    });

    test('an upcoming row keeps its status, and nothing of the server beyond the pick', async () => {
        stubStrategy(
            (filter) =>
                filter === 'upcoming'
                    ? [
                          {
                              id: 9,
                              title: 'Soon',
                              status: 'upcoming',
                              start_time: NOW + 600,
                              close_time: NOW + 9999,
                              entries: 0,
                              players: 0,
                              guru_info: { id: 'g' },
                          },
                      ]
                    : [],
            jest.fn(async (_token: string, _id: string) => []),
        );

        expect(await listItems()).toEqual([
            {
                id: 9,
                title: 'Soon',
                status: 'upcoming',
                start_time: NOW + 600,
                close_time: NOW + 9999,
                entries: 0,
                players: 0,
                chosenOwn: [],
                chosenOwnCount: 0,
                chosenEffectiveCount: 0,
            },
        ]);
    });

    test('a suggested read that fails leaves that row without suggestions, and the listing stands', async () => {
        const suggested = jest.fn(async (_token: string, id: string) => {
            if (id === '8') throw new Error('cache gone');
            return ['c'.repeat(32)];
        });
        stubStrategy(
            (filter) =>
                filter === 'open'
                    ? [
                          { id: 7, title: 'A' },
                          { id: 8, title: 'B' },
                      ]
                    : [],
            suggested,
        );

        const items = await listItems();
        expect(items[0].suggestedPhotoIds).toEqual(['c'.repeat(32)]);
        // A failed read is no suggestions: the field stays absent, and the listing still succeeded.
        expect('suggestedPhotoIds' in items[1]).toBe(false);
    });

    test('an item without an id asks for no suggestions', async () => {
        const suggested = jest.fn(async (_token: string, _id: string) => []);
        stubStrategy((filter) => (filter === 'open' ? [{ title: 'No id' }] : []), suggested);

        const items = await listItems();
        expect(suggested).not.toHaveBeenCalled();
        expect('suggestedPhotoIds' in items[0]).toBe(false);
    });
});
