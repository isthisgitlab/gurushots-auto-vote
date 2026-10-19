/**
 * The challenges Discover last listed, by id, for the settings-only reads that need a title or tags.
 */

import { invalid } from '../helpers/invalid';
import type * as cacheModule from '../../src/ts/services/openChallengeCache';
import type { DiscoverChallenge } from '../../src/ts/types/gurushots';

const { rememberOpenChallenges, getOpenChallenge, clearOpenChallenges } =
    require('../../src/ts/services/openChallengeCache') as typeof cacheModule;

const item = (id: number | string, title: string) => invalid<DiscoverChallenge>({ id, title });

beforeEach(() => clearOpenChallenges());

describe('rememberOpenChallenges', () => {
    test('replaces the previous list and finds a challenge by its id, number or text', () => {
        rememberOpenChallenges([item(1, 'One'), null, invalid<DiscoverChallenge>({ title: 'no id' })]);
        expect(getOpenChallenge(1)?.title).toBe('One');
        expect(getOpenChallenge('1')?.title).toBe('One');
        rememberOpenChallenges([item(2, 'Two')]);
        expect(getOpenChallenge(1)).toBeUndefined();
        expect(getOpenChallenge(2)?.title).toBe('Two');
    });

    test('keeps the ids it is told to keep, as they were, when the new list lacks them', () => {
        rememberOpenChallenges([item(1, 'One'), item(2, 'Two')]);
        // 1 just started: the upcoming feed dropped it and the open one does not list it yet.
        rememberOpenChallenges([item(2, 'Two again')], ['1']);
        expect(getOpenChallenge(1)?.title).toBe('One');
        expect(getOpenChallenge(2)?.title).toBe('Two again');
    });

    test('a kept id the cache never held stays unknown, and a kept id the list holds takes the new item', () => {
        rememberOpenChallenges([item(2, 'Two')], ['7', '2']);
        expect(getOpenChallenge(7)).toBeUndefined();
        expect(getOpenChallenge(2)?.title).toBe('Two');
        rememberOpenChallenges([item(2, 'Two, renamed')], ['2']);
        expect(getOpenChallenge(2)?.title).toBe('Two, renamed');
    });

    test('only what is kept survives: the rest of the old list goes', () => {
        rememberOpenChallenges([item(1, 'One'), item(2, 'Two')]);
        rememberOpenChallenges([], ['1']);
        expect(getOpenChallenge(1)?.title).toBe('One');
        expect(getOpenChallenge(2)).toBeUndefined();
        clearOpenChallenges();
        expect(getOpenChallenge(1)).toBeUndefined();
    });
});
