/**
 * Component tests for BoostWindowBanner.jsx — the summary above the challenge
 * list that names the challenges whose boost window is open right now and lets
 * the user jump to a card. Covers:
 *   - renders nothing when no boost window is open
 *   - lists exactly the open-window challenges, soonest-expiring first, with
 *     key-unlocked (no countdown) sorted last
 *   - timed chips show an "Xm left" countdown; key-unlocked chips do not
 *   - clicking a chip scrolls the matching challenge-<id> element into view
 */

import { render, screen, fireEvent } from '@/test/test-utils';
import { BoostWindowBanner } from '@/components/app/BoostWindowBanner';

const now = () => Math.floor(Date.now() / 1000);

const challenge = (id, title, boost) => ({ id, title, member: { boost } });

describe('BoostWindowBanner', () => {
    afterEach(() => jest.restoreAllMocks());

    test('renders nothing when no boost window is open', () => {
        render(
            <BoostWindowBanner
                challenges={[
                    challenge(1, 'Used', { state: 'USED' }),
                    challenge(2, 'Expired', { state: 'AVAILABLE', timeout: now() - 60 }),
                    challenge(3, 'Locked', { state: 'LOCKED' }),
                ]}
            />,
        );

        expect(screen.queryByRole('button')).toBeNull();
    });

    test('lists open windows soonest-first with key-unlocked last', () => {
        render(
            <BoostWindowBanner
                challenges={[
                    challenge(10, 'TenMin', { state: 'AVAILABLE', timeout: now() + 630 }),
                    challenge(11, 'KeyOne', { state: 'AVAILABLE_KEY' }),
                    challenge(12, 'TwoMin', { state: 'AVAILABLE', timeout: now() + 150 }),
                    challenge(13, 'Closed', { state: 'UNAVAILABLE' }),
                ]}
            />,
        );

        const buttons = screen.getAllByRole('button');
        expect(buttons).toHaveLength(3);
        expect(buttons[0].textContent).toMatch(/TwoMin/);
        expect(buttons[1].textContent).toMatch(/TenMin/);
        expect(buttons[2].textContent).toMatch(/KeyOne/);
    });

    test('timed chips show a countdown, key-unlocked chips do not', () => {
        render(
            <BoostWindowBanner
                challenges={[
                    challenge(20, 'Timed', { state: 'AVAILABLE', timeout: now() + 630 }),
                    challenge(21, 'Keyed', { state: 'AVAILABLE_KEY' }),
                ]}
            />,
        );

        expect(screen.getByRole('button', { name: /Timed/ }).textContent).toMatch(/10m left/);
        expect(screen.getByRole('button', { name: /Keyed/ }).textContent).not.toMatch(/left/);
    });

    test('sub-minute window shows "<1m left", not "0m left"', () => {
        render(
            <BoostWindowBanner
                challenges={[challenge(30, 'AlmostGone', { state: 'AVAILABLE', timeout: now() + 30 })]}
            />,
        );

        const chip = screen.getByRole('button', { name: /AlmostGone/ });
        expect(chip.textContent).toMatch(/<1m left/);
        expect(chip.textContent).not.toMatch(/0m left/);
    });

    test('long windows use h/m units, not raw minutes (645m → 10h 45m)', () => {
        // +30s buffer keeps the assertion off a minute boundary (sub-second
        // render drift can't flip "10h 45m").
        render(
            <BoostWindowBanner
                challenges={[challenge(40, 'LongRun', { state: 'AVAILABLE', timeout: now() + 645 * 60 + 30 })]}
            />,
        );

        const chip = screen.getByRole('button', { name: /LongRun/ });
        expect(chip.textContent).toMatch(/10h .*left/);
        expect(chip.textContent).not.toMatch(/645m/);
    });

    test('key-unlocked window with a stray positive timeout shows no countdown', () => {
        render(
            <BoostWindowBanner
                challenges={[challenge(31, 'KeyStray', { state: 'AVAILABLE_KEY', timeout: now() - 100 })]}
            />,
        );

        expect(screen.getByRole('button', { name: /KeyStray/ }).textContent).not.toMatch(/left/);
    });

    test('clicking a chip scrolls the matching card into view', () => {
        render(<BoostWindowBanner challenges={[challenge(42, 'JumpTo', { state: 'AVAILABLE_KEY' })]} />);

        const fakeCard = { scrollIntoView: jest.fn() };
        const getById = jest.spyOn(document, 'getElementById').mockReturnValue(fakeCard);

        fireEvent.click(screen.getByRole('button', { name: /JumpTo/ }));

        expect(getById).toHaveBeenCalledWith('challenge-42');
        expect(fakeCard.scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' });
    });
});
