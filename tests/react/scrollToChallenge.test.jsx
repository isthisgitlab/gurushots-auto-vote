/**
 * Unit tests for the scrollToChallenge helper shared by BoostWindowBanner and
 * ChallengeNav. Covers:
 *   - scrolls the matching challenge-<id> element into view
 *   - no-ops safely (no throw) when the card isn't mounted
 *   - a falsy id (0) still builds the correct selector
 */

import { scrollToChallenge } from '@/utils/scrollToChallenge';

describe('scrollToChallenge', () => {
    afterEach(() => jest.restoreAllMocks());

    test('scrolls the matching card into view', () => {
        const fakeCard = { scrollIntoView: jest.fn() };
        const getById = jest.spyOn(document, 'getElementById').mockReturnValue(fakeCard);

        scrollToChallenge(42);

        expect(getById).toHaveBeenCalledWith('challenge-42');
        expect(fakeCard.scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' });
    });

    test('no-ops without throwing when the card is not mounted', () => {
        const getById = jest.spyOn(document, 'getElementById').mockReturnValue(null);

        expect(() => scrollToChallenge(999)).not.toThrow();
        expect(getById).toHaveBeenCalledWith('challenge-999');
    });

    test('handles a falsy id (0) by building the correct selector', () => {
        const fakeCard = { scrollIntoView: jest.fn() };
        const getById = jest.spyOn(document, 'getElementById').mockReturnValue(fakeCard);

        scrollToChallenge(0);

        expect(getById).toHaveBeenCalledWith('challenge-0');
        expect(fakeCard.scrollIntoView).toHaveBeenCalled();
    });
});
