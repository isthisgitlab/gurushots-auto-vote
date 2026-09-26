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
        const fakeCard = { scrollIntoView: jest.fn(), focus: jest.fn() };
        const getById = jest.spyOn(document, 'getElementById').mockReturnValue(fakeCard);

        scrollToChallenge(42);

        expect(getById).toHaveBeenCalledWith('challenge-42');
        expect(fakeCard.scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' });
        expect(fakeCard.focus).toHaveBeenCalledWith({ preventScroll: true });
    });

    test('no-ops without throwing when the card is not mounted', () => {
        const getById = jest.spyOn(document, 'getElementById').mockReturnValue(null);

        expect(() => scrollToChallenge(999)).not.toThrow();
        expect(getById).toHaveBeenCalledWith('challenge-999');
    });

    test('handles a falsy id (0) by building the correct selector', () => {
        const fakeCard = { scrollIntoView: jest.fn(), focus: jest.fn() };
        const getById = jest.spyOn(document, 'getElementById').mockReturnValue(fakeCard);

        scrollToChallenge(0);

        expect(getById).toHaveBeenCalledWith('challenge-0');
        expect(fakeCard.scrollIntoView).toHaveBeenCalled();
    });

    test('moves the visible focus outline to the next jumped card', () => {
        const first = document.createElement('div');
        const second = document.createElement('div');
        first.id = 'challenge-1';
        second.id = 'challenge-2';
        first.tabIndex = second.tabIndex = -1;
        first.scrollIntoView = second.scrollIntoView = jest.fn();
        document.body.append(first, second);

        scrollToChallenge(1);
        expect(document.activeElement).toBe(first);
        scrollToChallenge(2);
        expect(document.activeElement).toBe(second);

        first.remove();
        second.remove();
    });
});
