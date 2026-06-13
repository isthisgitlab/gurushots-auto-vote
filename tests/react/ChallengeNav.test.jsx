/**
 * Component tests for ChallengeNav.jsx — the "jump to challenge" index above the
 * challenge list that names every active challenge and lets the user click a
 * name to scroll to its card. Covers:
 *   - renders nothing when there are no challenges
 *   - lists every challenge by title, in the order given
 *   - clicking an entry scrolls the matching challenge-<id> element into view
 */

import { render, screen, fireEvent } from '@/test/test-utils';
import { ChallengeNav } from '@/components/app/ChallengeNav';

const challenge = (id, title) => ({ id, title });

describe('ChallengeNav', () => {
    afterEach(() => jest.restoreAllMocks());

    test('renders nothing when there are no challenges', () => {
        render(<ChallengeNav challenges={[]} />);
        expect(screen.queryByRole('button')).toBeNull();
    });

    test('renders nothing when challenges is undefined', () => {
        render(<ChallengeNav />);
        expect(screen.queryByRole('button')).toBeNull();
    });

    test('lists every challenge by title in order', () => {
        render(<ChallengeNav challenges={[challenge(1, 'Alpha'), challenge(2, 'Bravo'), challenge(3, 'Charlie')]} />);

        const buttons = screen.getAllByRole('button');
        expect(buttons).toHaveLength(3);
        expect(buttons[0].textContent).toMatch(/Alpha/);
        expect(buttons[1].textContent).toMatch(/Bravo/);
        expect(buttons[2].textContent).toMatch(/Charlie/);
    });

    test('clicking an entry scrolls the matching card into view', () => {
        render(<ChallengeNav challenges={[challenge(42, 'JumpTo')]} />);

        const fakeCard = { scrollIntoView: jest.fn() };
        const getById = jest.spyOn(document, 'getElementById').mockReturnValue(fakeCard);

        fireEvent.click(screen.getByRole('button', { name: /JumpTo/ }));

        expect(getById).toHaveBeenCalledWith('challenge-42');
        expect(fakeCard.scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' });
    });
});
