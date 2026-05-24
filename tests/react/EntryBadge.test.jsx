/**
 * Component tests for EntryBadge.jsx — the most behaviorally dense
 * component in the renderer. Covers:
 *   - The mutual-exclusion rule: an entry that is already boosted OR
 *     already turbo'd hides BOTH per-entry buttons (isEntryActioned).
 *   - boostAvailable / turboAvailable independently gate their buttons
 *     even when the entry isn't actioned.
 *   - The 5-second error auto-clear (useEffect + setTimeout) calls
 *     clearError so a stuck red button doesn't trap the user.
 *   - The in-flight loading state disables the button and renders the
 *     spinner instead of the icon.
 *
 * The hook surface is stubbed via mock state objects mutated per-test.
 * Variable names start with "mock" so Jest's jest.mock hoisting accepts
 * them in the factory closure.
 */

import { act, render, screen } from '@/test/test-utils';
import { EntryBadge } from '@/components/app/EntryBadge';

const mockBoostState = {
    applyBoost: jest.fn(),
    loading: false,
    error: null,
    clearError: jest.fn(),
};
const mockTurboState = {
    applyTurbo: jest.fn(),
    loading: false,
    error: null,
    clearError: jest.fn(),
};

jest.mock('@/api/useBoost', () => ({ useBoost: () => mockBoostState }));
jest.mock('@/api/useTurbo', () => ({ useTurbo: () => mockTurboState }));

const resetHookState = () => {
    Object.assign(mockBoostState, {
        applyBoost: jest.fn(),
        loading: false,
        error: null,
        clearError: jest.fn(),
    });
    Object.assign(mockTurboState, {
        applyTurbo: jest.fn(),
        loading: false,
        error: null,
        clearError: jest.fn(),
    });
};

const baseEntry = (overrides = {}) => ({
    id: 'e1',
    rank: 3,
    votes: 42,
    boosted: false,
    turbo: false,
    ...overrides,
});

beforeEach(() => {
    resetHookState();
});

describe('EntryBadge — button visibility (mutual exclusion)', () => {
    test('shows boost button when boostAvailable and entry not actioned', () => {
        render(<EntryBadge entry={baseEntry()} challengeId={777} boostAvailable={true} turboAvailable={false} />);
        // Boost button rendered with rocket icon (not spinner).
        expect(screen.getByRole('button', { name: /🚀/ })).toBeTruthy();
    });

    test('shows turbo button when turboAvailable and entry not actioned', () => {
        render(<EntryBadge entry={baseEntry()} challengeId={777} boostAvailable={false} turboAvailable={true} />);
        expect(screen.getByRole('button', { name: /⚡/ })).toBeTruthy();
    });

    test('hides BOTH buttons when entry.boosted is true (mutual exclusion)', () => {
        render(
            <EntryBadge
                entry={baseEntry({ boosted: true })}
                challengeId={777}
                boostAvailable={true}
                turboAvailable={true}
            />,
        );
        expect(screen.queryByRole('button', { name: /🚀/ })).toBeNull();
        expect(screen.queryByRole('button', { name: /⚡/ })).toBeNull();
    });

    test('hides BOTH buttons when entry.turbo is truthy (mutual exclusion)', () => {
        render(
            <EntryBadge
                entry={baseEntry({ turbo: { id: 't1' } })}
                challengeId={777}
                boostAvailable={true}
                turboAvailable={true}
            />,
        );
        expect(screen.queryByRole('button', { name: /🚀/ })).toBeNull();
        expect(screen.queryByRole('button', { name: /⚡/ })).toBeNull();
    });

    test('reads entry.boosted (not entry.boost) — eligibility flag does not light up the rocket', () => {
        // entry.boost is the eligibility/availability indicator, not the
        // applied flag. Reading it as "applied" would hide the button on
        // any entry merely *eligible* for boost.
        render(
            <EntryBadge
                entry={baseEntry({ boost: true, boosted: false })}
                challengeId={777}
                boostAvailable={true}
                turboAvailable={false}
            />,
        );
        // Button must still be rendered even though entry.boost is true.
        expect(screen.getByRole('button', { name: /🚀/ })).toBeTruthy();
    });
});

describe('EntryBadge — loading state', () => {
    test('boost button is disabled and shows spinner when loading', () => {
        mockBoostState.loading = true;
        render(<EntryBadge entry={baseEntry()} challengeId={777} boostAvailable={true} turboAvailable={false} />);
        // Button found by its container; the icon is replaced by a
        // spinner so we can't query by icon name. Query by role instead.
        const buttons = screen.getAllByRole('button');
        expect(buttons).toHaveLength(1);
        expect(buttons[0].disabled).toBe(true);
        expect(buttons[0].querySelector('.loading-spinner')).toBeTruthy();
    });

    test('turbo button is disabled and shows spinner when loading', () => {
        mockTurboState.loading = true;
        render(<EntryBadge entry={baseEntry()} challengeId={777} boostAvailable={false} turboAvailable={true} />);
        const buttons = screen.getAllByRole('button');
        expect(buttons).toHaveLength(1);
        expect(buttons[0].disabled).toBe(true);
        expect(buttons[0].querySelector('.loading-spinner')).toBeTruthy();
    });
});

describe('EntryBadge — error auto-clear (5s timer)', () => {
    beforeEach(() => {
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    test('boost error triggers clearBoostError after 5 seconds', () => {
        mockBoostState.error = 'Boost failed';
        render(<EntryBadge entry={baseEntry()} challengeId={777} boostAvailable={true} turboAvailable={false} />);
        expect(mockBoostState.clearError).not.toHaveBeenCalled();

        act(() => {
            jest.advanceTimersByTime(4999);
        });
        expect(mockBoostState.clearError).not.toHaveBeenCalled();

        act(() => {
            jest.advanceTimersByTime(1);
        });
        expect(mockBoostState.clearError).toHaveBeenCalledTimes(1);
    });

    test('turbo error triggers clearTurboError after 5 seconds', () => {
        mockTurboState.error = 'Turbo failed';
        render(<EntryBadge entry={baseEntry()} challengeId={777} boostAvailable={false} turboAvailable={true} />);
        act(() => {
            jest.advanceTimersByTime(5000);
        });
        expect(mockTurboState.clearError).toHaveBeenCalledTimes(1);
    });

    test('no timer scheduled when there is no error', () => {
        // No error → useEffect early-returns; nothing should happen even
        // after a long advance.
        render(<EntryBadge entry={baseEntry()} challengeId={777} boostAvailable={true} turboAvailable={true} />);
        act(() => {
            jest.advanceTimersByTime(10_000);
        });
        expect(mockBoostState.clearError).not.toHaveBeenCalled();
        expect(mockTurboState.clearError).not.toHaveBeenCalled();
    });
});

describe('EntryBadge — error styling on button', () => {
    test('boost button gets btn-error class when there is a boost error', () => {
        mockBoostState.error = 'Boost failed';
        render(<EntryBadge entry={baseEntry()} challengeId={777} boostAvailable={true} turboAvailable={false} />);
        const button = screen.getByRole('button');
        expect(button.className).toMatch(/btn-error/);
        expect(button.className).not.toMatch(/btn-success/);
    });

    test('boost button gets btn-success class when there is no error', () => {
        render(<EntryBadge entry={baseEntry()} challengeId={777} boostAvailable={true} turboAvailable={false} />);
        const button = screen.getByRole('button');
        expect(button.className).toMatch(/btn-success/);
        expect(button.className).not.toMatch(/btn-error/);
    });
});
