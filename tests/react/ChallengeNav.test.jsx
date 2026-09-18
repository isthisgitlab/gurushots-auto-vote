/**
 * Component tests for ChallengeNav.jsx — the "jump to challenge" index above the
 * challenge list that names every active challenge and lets the user click a
 * name to scroll to its card. Covers:
 *   - renders nothing when there are no challenges
 *   - lists every challenge by title, in the order given
 *   - clicking an entry scrolls the matching challenge-<id> element into view
 *   - challenges with a per-challenge override are marked, others are not
 *   - the marker refreshes when a settings-changed event fires
 */

import { render, screen, fireEvent, waitFor, act } from './helpers/test-utils';
import { ChallengeNav } from '@/components/app/ChallengeNav';

const challenge = (id, title) => ({ id, title });

describe('ChallengeNav', () => {
    beforeEach(() => {
        window.api.getChallengeOverrides.mockReset();
        window.api.getChallengeOverrides.mockResolvedValue({});
        window.api.onSettingsChanged.mockReset();
        window.api.onSettingsChanged.mockReturnValue(undefined);
    });

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

    test('marks only the challenges that carry a per-challenge override', async () => {
        window.api.getChallengeOverrides.mockImplementation(async (id) => (id === '2' ? { exposureTarget: 90 } : {}));

        render(<ChallengeNav challenges={[challenge(1, 'Plain'), challenge(2, 'Tuned')]} />);

        const tuned = screen.getByRole('button', { name: /Tuned/ });
        const plain = screen.getByRole('button', { name: /Plain/ });

        await waitFor(() => expect(tuned.className).toMatch(/btn-accent/));
        expect(tuned.textContent).toMatch(/⚙️/);
        expect(tuned.getAttribute('title')).toBeTruthy();

        expect(plain.className).not.toMatch(/btn-accent/);
        expect(plain.textContent).not.toMatch(/⚙️/);
        expect(plain.getAttribute('title')).toBeNull();
    });

    test('marks nothing when a per-challenge override read fails', async () => {
        // The IPC handler falls back to null on error — a failed read must not
        // light up the chip.
        window.api.getChallengeOverrides.mockResolvedValue(null);

        render(<ChallengeNav challenges={[challenge(7, 'Solo')]} />);

        await waitFor(() => expect(window.api.getChallengeOverrides).toHaveBeenCalledWith('7'));
        expect(screen.getByRole('button', { name: /Solo/ }).className).not.toMatch(/btn-accent/);
    });

    test('picks up an override saved after mount, via settings-changed', async () => {
        // The modal saving an override broadcasts settings-changed; the marker
        // has to follow without a remount.
        let fireSettingsChanged;
        window.api.onSettingsChanged.mockImplementation((cb) => {
            fireSettingsChanged = cb;
            return () => {};
        });

        render(<ChallengeNav challenges={[challenge(5, 'Later')]} />);

        const chip = screen.getByRole('button', { name: /Later/ });
        await waitFor(() => expect(window.api.getChallengeOverrides).toHaveBeenCalledWith('5'));
        expect(chip.className).not.toMatch(/btn-accent/);

        window.api.getChallengeOverrides.mockResolvedValue({ exposureTarget: 80 });
        await act(async () => {
            fireSettingsChanged();
        });

        await waitFor(() => expect(chip.className).toMatch(/btn-accent/));
        expect(chip.textContent).toMatch(/⚙️/);
    });

    test('reads each id once when the list repeats one', async () => {
        render(<ChallengeNav challenges={[challenge(3, 'Dup A'), challenge(3, 'Dup B')]} />);

        await waitFor(() => expect(window.api.getChallengeOverrides).toHaveBeenCalledWith('3'));
        expect(window.api.getChallengeOverrides).toHaveBeenCalledTimes(1);
    });
});
