/**
 * Tests for settings/challengeFacts.ts — the process-local cache of the latest
 * active-challenge list (id -> title, id -> match facts), through its boundary
 * rules: a marked challenge keeps its id and carries its previous facts over,
 * and a prune-unsafe read merges the previous id set in instead of replacing it.
 *
 * The module is imported directly (tests are outside the facade's lint
 * boundary) because the module state IS the subject; every test starts from a
 * known state by replacing the whole map with a plain call.
 */

import type * as challengeFactsModule from '../../src/ts/settings/challengeFacts';
import type { Challenge } from '../../src/ts/types/gurushots';
import { invalid } from '../helpers/invalid';

const facts = require('../../src/ts/settings/challengeFacts') as typeof challengeFactsModule;

beforeEach(() => {
    // A plain call replaces the whole map — a clean slate per test.
    facts.rememberChallengeTitles([]);
});

describe('rememberChallengeTitles — marked challenges', () => {
    test('a marked challenge keeps its id and carries over its previous facts', () => {
        facts.rememberChallengeTitles([{ id: '7', title: 'Readable', tags: ['Turbo'], type: 'flash' }]);

        const marked = invalid<Partial<Challenge>>({ id: '7', title: 'garbage', type: 42, dataIssues: ['type'] });
        expect(facts.rememberChallengeTitles([marked])).toBe(true);

        expect(facts.isActiveChallengeId('7')).toBe(true);
        expect(facts.factsForChallengeId('7')).toEqual({
            tags: ['Turbo'],
            type: 'flash',
            max_photo_submits: null,
            start_time: null,
            close_time: null,
        });
        expect(facts.challengeTargetForId('7').title).toBe('Readable');
    });

    test('a marked challenge seen for the first time keeps its id, with no title and empty facts', () => {
        expect(facts.rememberChallengeTitles([{ id: 9, dataIssues: ['close_time'] }])).toBe(true);

        expect(facts.isActiveChallengeId(9)).toBe(true);
        expect(facts.factsForChallengeId(9)).toEqual({ tags: [] });
        expect(facts.challengeTargetForId(9).title).toBe('');
    });

    test('the first row for an id wins, marked or not', () => {
        facts.rememberChallengeTitles([
            { id: '3', title: 'First' },
            { id: '3', title: 'Second', dataIssues: ['member'] },
        ]);
        expect(facts.challengeTargetForId('3').title).toBe('First');

        facts.rememberChallengeTitles([
            { id: '4', dataIssues: ['member'] },
            { id: '4', title: 'Later' },
        ]);
        // The marked first row seeded the id; the later unmarked row is a duplicate.
        expect(facts.isActiveChallengeId('4')).toBe(true);
        expect(facts.challengeTargetForId('4').title).toBe('');
    });

    test('an empty dataIssues array does not mark — the challenge is observed as usual', () => {
        expect(facts.rememberChallengeTitles([{ id: 5, title: 'Fine', dataIssues: [] }])).toBe(true);
        expect(facts.challengeTargetForId(5).title).toBe('Fine');
    });
});

describe('rememberChallengeTitles — prune-unsafe merge', () => {
    test('a dropped id stays visible and keeps its facts; present challenges are re-observed', () => {
        facts.rememberChallengeTitles([
            { id: '1', title: 'Stay', tags: ['Turbo'] },
            { id: '2', title: 'Dropped' },
        ]);

        expect(facts.rememberChallengeTitles([{ id: '1', title: 'Stay' }], true)).toBe(true);

        expect(facts.isActiveChallengeId('1')).toBe(true);
        expect(facts.isActiveChallengeId('2')).toBe(true);
        expect(facts.challengeTargetForId('2').title).toBe('Dropped');
        expect(facts.getActiveChallengeIds()).toEqual(new Set(['1', '2']));
    });

    test('a safe read still replaces the previous id set', () => {
        facts.rememberChallengeTitles([
            { id: '1', title: 'A' },
            { id: '2', title: 'B' },
        ]);
        facts.rememberChallengeTitles([{ id: '1', title: 'A' }]);

        expect(facts.isActiveChallengeId('2')).toBe(false);
        expect(facts.getActiveChallengeIds()).toEqual(new Set(['1']));
    });

    test('the merge also keeps a marked challenge of the unsafe read alive with its previous facts', () => {
        facts.rememberChallengeTitles([{ id: '1', title: 'Known', type: 'flash' }]);

        expect(facts.rememberChallengeTitles([{ id: '1', dataIssues: ['start_time'] }], true)).toBe(true);

        expect(facts.isActiveChallengeId('1')).toBe(true);
        expect(facts.factsForChallengeId('1')).toEqual({
            tags: [],
            type: 'flash',
            max_photo_submits: null,
            start_time: null,
            close_time: null,
        });
    });

    test('a prune-unsafe read re-observes a known challenge: its new title and facts replace the seeded copies', () => {
        facts.rememberChallengeTitles([{ id: '1', title: 'Old', tags: ['Turbo'], type: 'flash' }]);

        expect(
            facts.rememberChallengeTitles([{ id: '1', title: 'Renamed', tags: ['Classic'], type: 'default' }], true),
        ).toBe(true);

        expect(facts.isActiveChallengeId('1')).toBe(true);
        expect(facts.challengeTargetForId('1').title).toBe('Renamed');
        expect(facts.factsForChallengeId('1')).toEqual({
            tags: ['Classic'],
            type: 'default',
            max_photo_submits: null,
            start_time: null,
            close_time: null,
        });
    });

    test('a duplicate id in one prune-unsafe batch still keeps the first row', () => {
        facts.rememberChallengeTitles([{ id: '1', title: 'Seeded', tags: ['Turbo'] }]);

        expect(
            facts.rememberChallengeTitles(
                [
                    { id: '1', title: 'First', tags: ['Classic'] },
                    { id: '1', title: 'Second', tags: ['Magazine'] },
                ],
                true,
            ),
        ).toBe(true);

        expect(facts.challengeTargetForId('1').title).toBe('First');
        expect(facts.factsForChallengeId('1').tags).toEqual(['Classic']);
    });

    test('a marked first row wins the batch too: the later unmarked duplicate is skipped', () => {
        facts.rememberChallengeTitles([{ id: '2', title: 'Known', type: 'flash' }]);

        expect(
            facts.rememberChallengeTitles(
                [
                    { id: '2', dataIssues: ['type'] },
                    { id: '2', title: 'Later' },
                ],
                true,
            ),
        ).toBe(true);

        expect(facts.isActiveChallengeId('2')).toBe(true);
        expect(facts.challengeTargetForId('2').title).toBe('Known');
        expect(facts.factsForChallengeId('2').type).toBe('flash');
    });
});
