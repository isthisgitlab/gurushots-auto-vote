/**
 * services/boostGuard/selection: the remembered challenge list and the
 * imminent-boost selection that the quit dialog and the sleep boost share.
 */

import type * as selectionModule from '../../../src/ts/core/services/boostGuard/selection';
import type { Challenge } from '../../../src/ts/core/types/gurushots';
import { invalid } from '../../helpers/invalid';

const NOW = 1_000_000;
const timed = invalid<Challenge>({
    id: 1,
    title: 'Anything Music',
    member: { boost: { state: 'AVAILABLE', timeout: NOW + 1140 } },
});
const keyed = invalid<Challenge>({ id: 2, title: 'Metal & Wood', member: { boost: { state: 'AVAILABLE_KEY' } } });

let selection: typeof selectionModule;

beforeEach(() => {
    // Module-level state (the remembered list) must not leak across tests.
    jest.resetModules();
    selection = require('../../../src/ts/core/services/boostGuard/selection') as typeof selection;
});

describe('remembered list — suspend selection', () => {
    test('the suspend horizon is 30 min: due at exactly 30 min is selected, 31 min is not', () => {
        selection.rememberChallenges([keyed], false);
        const at = (sec: number) => () => ({ actions: [{ action: 'boost', dueAt: NOW + sec }] });
        expect(selection.SUSPEND_BOOST_HORIZON_SEC).toBe(30 * 60);
        expect(
            selection.imminentBoostChallenges(NOW, at(1800), selection.SUSPEND_BOOST_HORIZON_SEC, null),
        ).toHaveLength(1);
        expect(
            selection.imminentBoostChallenges(NOW, at(1860), selection.SUSPEND_BOOST_HORIZON_SEC, null),
        ).toHaveLength(0);
    });

    test('rememberChallenges records the mock flag it was fetched under; a non-array leaves both untouched', () => {
        expect(selection.rememberedChallengesMock()).toBeNull();
        selection.rememberChallenges([timed], true);
        expect(selection.rememberedChallengesMock()).toBe(true);
        selection.rememberChallenges(undefined, false);
        expect(selection.rememberedChallengesMock()).toBe(true);
        selection.resetBoostSelection();
        expect(selection.rememberedChallengesMock()).toBeNull();
    });

    test('resetBoostSelection clears the remembered list, so nothing is selected any more', () => {
        selection.rememberChallenges([timed], false);
        const describe = () => ({ actions: [{ action: 'boost', dueAt: NOW + 540 }] });
        expect(selection.imminentBoostChallenges(NOW, describe, 3600, null)).toHaveLength(1);
        selection.resetBoostSelection();
        expect(selection.imminentBoostChallenges(NOW, describe, 3600, null)).toEqual([]);
    });

    test('markBoostApplied ignores an unknown id and a challenge without a boost', () => {
        const bare = invalid<Challenge>({ id: 9, title: 'Bare' });
        selection.rememberChallenges([bare, timed], false);
        expect(() => selection.markBoostApplied(9)).not.toThrow();
        expect(() => selection.markBoostApplied(404)).not.toThrow();
        expect(timed.member?.boost?.state).toBe('AVAILABLE');
    });
});
