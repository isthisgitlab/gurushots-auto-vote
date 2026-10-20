/**
 * Component tests for ChallengeNav.tsx — the "jump to challenge" index above the
 * challenge list that names every active challenge and lets the user click a
 * name to scroll to its card. Covers:
 *   - renders nothing when there are no challenges
 *   - lists every challenge by title, in the order given
 *   - clicking an entry scrolls the matching challenge-<id> element into view
 *   - challenges with a per-challenge override are marked, others are not
 *   - the marker refreshes when a settings-changed event fires
 *   - a team-match challenge carries the T badge with sr-only text, others do not
 */

import { render, screen, fireEvent, waitFor, act } from './helpers/test-utils';
import { fireSettingsChanged } from './helpers/setup';
import { titleRuleInfo } from './helpers/titleRules';
import { ChallengeNav } from '@/components/app/ChallengeNav';
import type { Challenge } from '../../src/ts/types/gurushots';
import { invalid } from '../helpers/invalid';

const challenge = (id: number, title: string) => invalid<Challenge>({ id, title });
/** A running challenge at 5% exposure, which the jump list flags with a red dot. */
const lowExposureChallenge = (id: number, title: string) => {
    const nowSec = Math.floor(Date.now() / 1000);
    return invalid<Challenge>({
        id,
        title,
        start_time: nowSec - 3600,
        close_time: nowSec + 3600,
        member: { ranking: { exposure: { exposure_factor: 5 } } },
    });
};

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

        const fakeCard = Object.assign(document.createElement('div'), { scrollIntoView: jest.fn(), focus: jest.fn() });
        const getById = jest.spyOn(document, 'getElementById').mockReturnValue(fakeCard);

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

        await waitFor(() => expect(tuned.textContent).toMatch(/⚙️/));
        expect(tuned.className).toContain('btn-accent');
        expect(tuned.querySelector('.truncate')!.getAttribute('title')).toMatch(/^Tuned — ./);

        expect(plain.textContent).not.toMatch(/⚙️/);
        expect(plain.className).toBe('btn btn-sm max-w-full whitespace-nowrap');
        expect(plain.querySelector('.truncate')!.getAttribute('title')).toBe('Plain');
    });

    test('marks an automatically profiled challenge without a manual override', async () => {
        jest.mocked(window.api.getChallengeOverrides).mockImplementation(async (id) =>
            id === '4' ? { exposureTarget: 90 } : {},
        );
        jest.mocked(window.api.getTitleProfile).mockImplementation(async (_title, id) =>
            id === '2' || id === '4'
                ? titleRuleInfo({ profile: { name: '4 pics', values: { exposureTarget: 90 } } })
                : id === '3'
                  ? titleRuleInfo({ profile: { name: '4 pics', values: {} }, suppressed: true })
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
        const suppressed = screen.getByRole('button', { name: /Suppressed/ });
        const mixed = screen.getByRole('button', { name: /Mixed/ });
        await waitFor(() => expect(profiled.textContent).toMatch(/🔄/));
        expect(profiled.querySelector('.truncate')!.getAttribute('title')).toContain('app.titleRuleProfile');
        expect(suppressed.textContent).not.toMatch(/🔄/);
        expect(profiled.className).toContain('btn-info');
        expect(suppressed.className).not.toMatch(/btn-(info|accent|secondary)/);
        expect(mixed.textContent).toMatch(/⚙️.*🔄/);
        expect(mixed.className).toContain('btn-info');
        expect(mixed.className).not.toContain('btn-accent');
        expect(mixed.querySelector('.truncate')!.getAttribute('title')).toContain(
            'app.customSettingsHint · app.titleRuleProfile',
        );
    });

    test('marks a challenge a rule customizes on its own with its own marker and text, not the profile one', async () => {
        jest.mocked(window.api.getTitleProfile).mockImplementation(async (_title, id) =>
            id === '8'
                ? titleRuleInfo({
                      inlineValues: { scenario: 'Plan' },
                      ruleSources: { scenario: { title: 'Seaside', index: 1 } },
                  })
                : // Join-only values change nothing once joined.
                  titleRuleInfo({ inlineValues: { autoJoin: true } }),
        );
        render(<ChallengeNav challenges={[challenge(8, 'Ruled'), challenge(9, 'Join only')]} />);

        const ruled = screen.getByRole('button', { name: /Ruled/ });
        const joinOnly = screen.getByRole('button', { name: /Join only/ });
        await waitFor(() => expect(ruled.textContent).toMatch(/📏/));
        expect(ruled.querySelector('.truncate')!.getAttribute('title')).toContain('app.ruleSettingsHint');
        expect(ruled.textContent).toContain('app.ruleSettingsHint');
        expect(ruled.textContent).not.toContain('app.titleRuleProfile');
        expect(joinOnly.textContent).not.toMatch(/📏/);
        expect(ruled.className).toContain('btn-secondary');
        expect(joinOnly.className).not.toMatch(/btn-(info|accent|secondary)/);
    });

    test('marks a team-match challenge with the T badge and sr-only text, and others not', () => {
        const team = (id: number, title: string) =>
            invalid<Challenge>({
                id,
                title,
                teamMatch: { us: { name: 'Us', votes: 3 }, them: { name: 'Them', votes: 1 } },
            });
        render(<ChallengeNav challenges={[team(11, 'Team'), challenge(12, 'Solo')]} />);

        const teamChip = screen.getByRole('button', { name: /Team/ });
        const soloChip = screen.getByRole('button', { name: /Solo/ });

        const badge = teamChip.querySelector('.badge');
        expect(badge).not.toBeNull();
        expect(badge!.getAttribute('aria-hidden')).toBe('true');
        expect(badge!.textContent).toBe('T');
        expect(badge!.className).toContain('badge-primary');
        // The label reaches screen readers once, through the hint's sr-only span.
        expect(teamChip.textContent?.match(/app\.teamChallenge/g)).toHaveLength(1);
        expect(teamChip.querySelector('.truncate')!.getAttribute('title')).toContain('app.teamChallenge');

        expect(soloChip.querySelector('.badge')).toBeNull();
        expect(soloChip.textContent).not.toContain('app.teamChallenge');
    });

    test('rings the low-exposure dot on a coloured chip, not on a plain one', async () => {
        jest.mocked(window.api.getChallengeOverrides).mockImplementation(async (id) =>
            id === '1' ? { exposureTarget: 90 } : {},
        );
        jest.mocked(window.api.getTitleProfile).mockImplementation(async (_title, id) =>
            id === '2'
                ? titleRuleInfo({ inlineValues: { scenario: 'Plan' } })
                : id === '4'
                  ? titleRuleInfo({ profile: { name: '4 pics', values: { exposureTarget: 90 } } })
                  : null,
        );

        render(
            <ChallengeNav
                challenges={[
                    lowExposureChallenge(1, 'Manual low'),
                    lowExposureChallenge(2, 'Rule low'),
                    lowExposureChallenge(3, 'Plain low'),
                    lowExposureChallenge(4, 'Profiled low'),
                ]}
            />,
        );

        const manual = screen.getByRole('button', { name: /Manual low/ });
        const rule = screen.getByRole('button', { name: /Rule low/ });
        const plain = screen.getByRole('button', { name: /Plain low/ });
        const profiled = screen.getByRole('button', { name: /Profiled low/ });
        await waitFor(() => expect(manual.className).toContain('btn-accent'));
        await waitFor(() => expect(rule.className).toContain('btn-secondary'));
        await waitFor(() => expect(profiled.className).toContain('btn-info'));
        const dotParent = (chip: HTMLElement) =>
            chip.querySelector<HTMLElement>('[data-testid="pulse-dot-error"]')!.parentElement!;
        for (const chip of [manual, rule, profiled]) {
            expect(dotParent(chip).className).toContain('ring-base-100');
            expect(dotParent(chip).className).toContain('rounded-selector');
        }
        // No wrapper on a plain chip: the dot sits directly in the chip button.
        expect(dotParent(plain)).toBe(plain);
    });

    test("draws the boost dot in the chip's own content colour on a profiled chip, and plain on others", async () => {
        jest.mocked(window.api.getTitleProfile).mockImplementation(async (_title, id) =>
            id === '1' ? titleRuleInfo({ profile: { name: '4 pics', values: { exposureTarget: 90 } } }) : null,
        );
        const boosted = (id: number, title: string) =>
            invalid<Challenge>({ id, title, member: { boost: { state: 'AVAILABLE_KEY' } } });

        render(<ChallengeNav challenges={[boosted(1, 'Profiled boost'), boosted(2, 'Plain boost')]} />);

        const profiled = screen.getByRole('button', { name: /Profiled boost/ });
        const plain = screen.getByRole('button', { name: /Plain boost/ });
        await waitFor(() => expect(profiled.className).toContain('btn-info'));
        expect(profiled.querySelector('.bg-info-content')).not.toBeNull();
        expect(profiled.querySelector('.status-info')).toBeNull();
        expect(plain.querySelector('.status-info')).not.toBeNull();
        expect(plain.querySelector('.bg-info-content')).toBeNull();
        const dotParent = (chip: HTMLElement) =>
            chip.querySelector<HTMLElement>('[data-testid="pulse-dot-info"]')!.parentElement!;
        expect(dotParent(profiled).className).toContain('ring-base-100');
        expect(dotParent(plain)).toBe(plain);
    });

    test('marks nothing when a per-challenge override read fails', async () => {
        // The IPC handler falls back to null on error — a failed read must not
        // light up the chip.
        jest.mocked(window.api.getChallengeOverrides).mockResolvedValue(null);

        render(<ChallengeNav challenges={[challenge(7, 'Solo')]} />);

        await waitFor(() => expect(window.api.getChallengeOverrides).toHaveBeenCalledWith('7'));
        expect(screen.getByRole('button', { name: /Solo/ }).textContent).not.toMatch(/⚙️/);
    });

    test('picks up an override saved after mount, via settings-changed', async () => {
        // The modal saving an override broadcasts settings-changed; the marker
        // has to follow without a remount.
        render(<ChallengeNav challenges={[challenge(5, 'Later')]} />);

        const chip = screen.getByRole('button', { name: /Later/ });
        await waitFor(() => expect(window.api.getChallengeOverrides).toHaveBeenCalledWith('5'));
        expect(chip.textContent).not.toMatch(/⚙️/);

        jest.mocked(window.api.getChallengeOverrides).mockResolvedValue({ exposureTarget: 80 });
        await act(async () => {
            fireSettingsChanged();
        });

        await waitFor(() => expect(chip.textContent).toMatch(/⚙️/));
    });

    test('picks up a newly assigned automatic profile via settings-changed', async () => {
        render(<ChallengeNav challenges={[challenge(6, 'Later Profile')]} />);

        const chip = screen.getByRole('button', { name: /Later Profile/ });
        await waitFor(() => expect(window.api.getTitleProfile).toHaveBeenCalledWith('Later Profile', '6'));
        expect(chip.textContent).not.toMatch(/🔄/);

        jest.mocked(window.api.getTitleProfile).mockResolvedValue(
            titleRuleInfo({ profile: { name: '4 pics', values: {} } }),
        );
        await act(async () => {
            fireSettingsChanged();
        });

        await waitFor(() => expect(chip.textContent).toMatch(/🔄/));
    });

    test('reads each id once when the list repeats one', async () => {
        render(<ChallengeNav challenges={[challenge(3, 'Dup A'), challenge(3, 'Dup B')]} />);

        await waitFor(() => expect(window.api.getChallengeOverrides).toHaveBeenCalledWith('3'));
        expect(window.api.getChallengeOverrides).toHaveBeenCalledTimes(1);
    });
});
