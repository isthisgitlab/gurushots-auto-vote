/**
 * Component tests for ChallengeNav.tsx — the "jump to challenge" index above the
 * challenge list that names every active challenge and lets the user click a
 * name to scroll to its card. Covers:
 *   - renders nothing when there are no challenges
 *   - lists every challenge by title, in the order given
 *   - clicking an entry scrolls the matching challenge-<id> element into view
 *   - challenges with a per-challenge override are marked, others are not
 *   - the marker refreshes when a settings-changed event fires
 */

import { render, screen, fireEvent, waitFor, act } from './helpers/test-utils';
import { fireSettingsChanged } from './helpers/setup';
import { ChallengeNav } from '@/components/app/ChallengeNav';
import type { Challenge } from '../../src/js/types/gurushots';
import { invalid } from '../helpers/invalid';

const challenge = (id: number, title: string) => invalid<Challenge>({ id, title });

describe('ChallengeNav', () => {
    beforeEach(() => {
        jest.mocked(window.api.getChallengeOverrides).mockReset();
        jest.mocked(window.api.getChallengeOverrides).mockResolvedValue({});
        jest.mocked(window.api.getTitleProfile).mockReset();
        jest.mocked(window.api.getTitleProfile).mockResolvedValue(null);
    });

    afterEach(() => jest.restoreAllMocks());

    test('renders nothing when there are no challenges', () => {
        render(<ChallengeNav challenges={[]} />);
        expect(screen.queryByRole('button')).toBeNull();
    });

    test('renders nothing when challenges is undefined', () => {
        render(<ChallengeNav challenges={undefined} />);
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

        const fakeCard = { scrollIntoView: jest.fn(), focus: jest.fn() };
        const getById = jest.spyOn(document, 'getElementById').mockReturnValue(invalid(fakeCard));

        fireEvent.click(screen.getByRole('button', { name: /JumpTo/ }));

        expect(getById).toHaveBeenCalledWith('challenge-42');
        expect(fakeCard.scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' });
        expect(fakeCard.focus).toHaveBeenCalledWith({ preventScroll: true });
    });

    test('marks only the challenges that carry a per-challenge override', async () => {
        jest.mocked(window.api.getChallengeOverrides).mockImplementation(async (id) =>
            id === '2' ? { exposureTarget: 90 } : {},
        );

        render(<ChallengeNav challenges={[challenge(1, 'Plain'), challenge(2, 'Tuned')]} />);

        const tuned = screen.getByRole('button', { name: /Tuned/ });
        const plain = screen.getByRole('button', { name: /Plain/ });

        await waitFor(() => expect(tuned.className).toMatch(/btn-accent/));
        expect(tuned.textContent).toMatch(/⚙️/);
        expect(tuned.className).not.toMatch(/btn-info/);
        expect(tuned.querySelector('.truncate')!.getAttribute('title')).toMatch(/^Tuned — ./);

        expect(plain.className).not.toMatch(/btn-accent/);
        expect(plain.textContent).not.toMatch(/⚙️/);
        expect(plain.querySelector('.truncate')!.getAttribute('title')).toBe('Plain');
    });

    test('marks an automatically profiled challenge without a manual override', async () => {
        jest.mocked(window.api.getChallengeOverrides).mockImplementation(async (id) =>
            id === '4' ? { exposureTarget: 90 } : {},
        );
        jest.mocked(window.api.getTitleProfile).mockImplementation(async (_title, id) =>
            id === '2' || id === '4'
                ? { name: '4 pics', values: { exposureTarget: 90 }, suppressed: false }
                : id === '3'
                  ? { name: '4 pics', values: {}, suppressed: true }
                  : null,
        );

        render(
            <ChallengeNav
                challenges={[
                    challenge(1, 'Plain'),
                    challenge(2, 'Profiled'),
                    challenge(3, 'Suppressed'),
                    challenge(4, 'Mixed'),
                ]}
            />,
        );

        const profiled = screen.getByRole('button', { name: /Profiled/ });
        const plain = screen.getByRole('button', { name: /Plain/ });
        const suppressed = screen.getByRole('button', { name: /Suppressed/ });
        const mixed = screen.getByRole('button', { name: /Mixed/ });
        await waitFor(() => expect(profiled.className).toMatch(/btn-info/));
        expect(profiled.textContent).toMatch(/🔄/);
        expect(profiled.className).not.toMatch(/btn-accent/);
        expect(profiled.querySelector('.truncate')!.getAttribute('title')).toContain('app.titleRuleProfile');
        expect(plain.className).not.toMatch(/btn-accent/);
        expect(suppressed.className).not.toMatch(/btn-info/);
        expect(suppressed.textContent).not.toMatch(/🔄/);
        expect(mixed.className).toMatch(/btn-info/);
        expect(mixed.textContent).toMatch(/⚙️.*🔄/);
        expect(mixed.querySelector('.truncate')!.getAttribute('title')).toContain(
            'app.customSettingsHint · app.titleRuleProfile',
        );
    });

    test('marks nothing when a per-challenge override read fails', async () => {
        // The IPC handler falls back to null on error — a failed read must not
        // light up the chip.
        jest.mocked(window.api.getChallengeOverrides).mockResolvedValue(null);

        render(<ChallengeNav challenges={[challenge(7, 'Solo')]} />);

        await waitFor(() => expect(window.api.getChallengeOverrides).toHaveBeenCalledWith('7'));
        expect(screen.getByRole('button', { name: /Solo/ }).className).not.toMatch(/btn-accent/);
    });

    test('picks up an override saved after mount, via settings-changed', async () => {
        // The modal saving an override broadcasts settings-changed; the marker
        // has to follow without a remount.
        render(<ChallengeNav challenges={[challenge(5, 'Later')]} />);

        const chip = screen.getByRole('button', { name: /Later/ });
        await waitFor(() => expect(window.api.getChallengeOverrides).toHaveBeenCalledWith('5'));
        expect(chip.className).not.toMatch(/btn-accent/);

        jest.mocked(window.api.getChallengeOverrides).mockResolvedValue({ exposureTarget: 80 });
        await act(async () => {
            fireSettingsChanged();
        });

        await waitFor(() => expect(chip.className).toMatch(/btn-accent/));
        expect(chip.textContent).toMatch(/⚙️/);
    });

    test('picks up a newly assigned automatic profile via settings-changed', async () => {
        render(<ChallengeNav challenges={[challenge(6, 'Later Profile')]} />);

        const chip = screen.getByRole('button', { name: /Later Profile/ });
        await waitFor(() => expect(window.api.getTitleProfile).toHaveBeenCalledWith('Later Profile', '6'));
        expect(chip.className).not.toMatch(/btn-accent/);

        jest.mocked(window.api.getTitleProfile).mockResolvedValue({ name: '4 pics', values: {}, suppressed: false });
        await act(async () => {
            fireSettingsChanged();
        });

        await waitFor(() => expect(chip.className).toMatch(/btn-info/));
    });

    test('reads each id once when the list repeats one', async () => {
        render(<ChallengeNav challenges={[challenge(3, 'Dup A'), challenge(3, 'Dup B')]} />);

        await waitFor(() => expect(window.api.getChallengeOverrides).toHaveBeenCalledWith('3'));
        expect(window.api.getChallengeOverrides).toHaveBeenCalledTimes(1);
    });
});
