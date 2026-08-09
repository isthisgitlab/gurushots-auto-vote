/**
 * Tests for the shared chip-list pieces (components/app/ChallengeChips)
 * extracted from ChallengeNav and BoostWindowBanner: the bordered panel
 * with heading + count, and the scroll-to-card chip button.
 */

import { render, screen, fireEvent } from './helpers/test-utils';
import { ChipListPanel, ChallengeChip } from '@/components/app/ChallengeChips';

describe('ChipListPanel', () => {
    test('renders the heading (icon + label + count) and the chip row', () => {
        const { container } = render(
            <ChipListPanel icon="📋" label="Jump" count={2}>
                <span>child</span>
            </ChipListPanel>,
        );

        expect(container.firstChild.className).toBe('rounded-lg border border-base-300 bg-base-100 p-2 mb-4');
        const heading = container.querySelector('.text-sm.font-medium');
        expect(heading.textContent).toBe('📋 Jump (2)');
        expect(heading.querySelector('span[aria-hidden="true"]').textContent).toBe('📋');
        expect(container.querySelector('.flex.flex-wrap.gap-2').textContent).toBe('child');
    });
});

describe('ChallengeChip', () => {
    afterEach(() => jest.restoreAllMocks());

    test('renders the chip button markup and scrolls to the card on click', () => {
        render(<ChallengeChip challengeId={42}>JumpTo</ChallengeChip>);

        const chip = screen.getByRole('button', { name: /JumpTo/ });
        expect(chip.className).toBe('btn btn-xs h-auto whitespace-normal text-left');
        expect(chip.getAttribute('type')).toBe('button');

        const fakeCard = { scrollIntoView: jest.fn() };
        const getById = jest.spyOn(document, 'getElementById').mockReturnValue(fakeCard);
        fireEvent.click(chip);

        expect(getById).toHaveBeenCalledWith('challenge-42');
        expect(fakeCard.scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' });
    });
});
