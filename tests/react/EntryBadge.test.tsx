/**
 * Component tests for EntryBadge.tsx — the most behaviorally dense
 * component in the renderer. Covers:
 *   - The mutual-exclusion rule: an entry that is already boosted OR
 *     already turbo'd hides BOTH per-entry buttons (isEntryActioned).
 *   - boostAvailable / turboAvailable independently gate their buttons
 *     even when the entry isn't actioned.
 *   - A failed action's message is announced (role="alert") and stays until
 *     it is dismissed or the next action starts.
 *   - The in-flight loading state disables the button and renders the
 *     spinner instead of the icon.
 *
 * The hook surface is stubbed via mock state objects mutated per-test.
 * Variable names start with "mock" so Jest's jest.mock hoisting accepts
 * them in the factory closure.
 */

import { act, fireEvent, render, screen } from './helpers/test-utils';
import { EntryBadge } from '@/components/app/EntryBadge';

const mockBoostState = {
    applyBoost: jest.fn(),
    loading: false,
    error: null as string | null,
    clearError: jest.fn(),
};
const mockTurboState = {
    applyTurbo: jest.fn(),
    loading: false,
    error: null as string | null,
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

// The parent callbacks are never triggered here.
const noCallbacks = { onBoostApplied: () => {}, onTurboApplied: () => {}, onSwapped: () => {}, onChooseSwap: () => {} };

beforeEach(() => {
    resetHookState();
});

describe('EntryBadge — button visibility (mutual exclusion)', () => {
    test('shows boost button when boostAvailable and entry not actioned', () => {
        render(
            <EntryBadge
                timezone="local"
                {...noCallbacks}
                entry={baseEntry()}
                challengeId={777}
                boostAvailable={true}
                turboAvailable={false}
            />,
        );
        // Boost button rendered with rocket icon (not spinner).
        expect(screen.getByRole('button', { name: /🚀/ })).toBeTruthy();
    });

    test('shows turbo button when turboAvailable and entry not actioned', () => {
        render(
            <EntryBadge
                timezone="local"
                {...noCallbacks}
                entry={baseEntry()}
                challengeId={777}
                boostAvailable={false}
                turboAvailable={true}
            />,
        );
        expect(screen.getByRole('button', { name: /⚡/ })).toBeTruthy();
    });

    test('hides BOTH buttons when entry.boosted is true (mutual exclusion)', () => {
        render(
            <EntryBadge
                timezone="local"
                {...noCallbacks}
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
                timezone="local"
                {...noCallbacks}
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
                timezone="local"
                {...noCallbacks}
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
        render(
            <EntryBadge
                timezone="local"
                {...noCallbacks}
                entry={baseEntry()}
                challengeId={777}
                boostAvailable={true}
                turboAvailable={false}
            />,
        );
        // Button found by its container; the icon is replaced by a
        // spinner so we can't query by icon name. Query by role instead.
        const buttons = screen.getAllByRole('button');
        expect(buttons).toHaveLength(1);
        expect((buttons[0] as HTMLButtonElement).disabled).toBe(true);
        expect(buttons[0].querySelector('.loading-spinner')).toBeTruthy();
    });

    test('turbo button is disabled and shows spinner when loading', () => {
        mockTurboState.loading = true;
        render(
            <EntryBadge
                timezone="local"
                {...noCallbacks}
                entry={baseEntry()}
                challengeId={777}
                boostAvailable={false}
                turboAvailable={true}
            />,
        );
        const buttons = screen.getAllByRole('button');
        expect(buttons).toHaveLength(1);
        expect((buttons[0] as HTMLButtonElement).disabled).toBe(true);
        expect(buttons[0].querySelector('.loading-spinner')).toBeTruthy();
    });
});

describe('EntryBadge — a failed action stays until dismissed', () => {
    beforeEach(() => {
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    const renderBadge = () =>
        render(
            <EntryBadge
                timezone="local"
                {...noCallbacks}
                entry={baseEntry()}
                challengeId={777}
                boostAvailable={true}
                turboAvailable={true}
            />,
        );

    test('the error is announced and is not cleared by a timer', () => {
        mockBoostState.error = 'Boost failed';
        renderBadge();
        expect(screen.getByRole('alert')).toBeTruthy();

        act(() => {
            jest.advanceTimersByTime(60_000);
        });
        expect(mockBoostState.clearError).not.toHaveBeenCalled();
        expect(mockTurboState.clearError).not.toHaveBeenCalled();
        expect(screen.getByRole('alert')).toBeTruthy();
    });

    test('Dismiss clears both the boost and the turbo error', () => {
        mockTurboState.error = 'Turbo failed';
        renderBadge();
        fireEvent.click(screen.getByRole('button', { name: 'errors.dismiss' }));
        expect(mockBoostState.clearError).toHaveBeenCalledTimes(1);
        expect(mockTurboState.clearError).toHaveBeenCalledTimes(1);
    });

    test('no alert and no dismiss button without an error', () => {
        renderBadge();
        expect(screen.queryByRole('alert')).toBeNull();
        expect(screen.queryByRole('button', { name: 'errors.dismiss' })).toBeNull();
    });
});

describe('EntryBadge — error text', () => {
    const renderBadge = () =>
        render(
            <EntryBadge
                timezone="local"
                {...noCallbacks}
                entry={baseEntry()}
                challengeId={777}
                boostAvailable={true}
                turboAvailable={false}
            />,
        );

    test('shows a known handler failure translated, never the English handler text', () => {
        mockBoostState.error = 'Failed to apply boost';
        renderBadge();
        expect(screen.queryByText('Failed to apply boost')).toBeNull();
        expect(screen.getByText('errors.boostFailed')).toBeTruthy();
    });

    test('an unlisted failure reads as the generic translated failure', () => {
        mockBoostState.error = 'ECONNRESET at socket.js:12';
        renderBadge();
        expect(screen.queryByText(/ECONNRESET/)).toBeNull();
        expect(screen.getByText('errors.actionFailed')).toBeTruthy();
    });

    test('shows translated text for the invalid-args machine code', () => {
        mockTurboState.error = 'invalid-args';
        renderBadge();
        expect(screen.queryByText('invalid-args')).toBeNull();
        expect(screen.getByText('errors.actionInvalidArgs')).toBeTruthy();
    });
});

describe('EntryBadge — error styling on button', () => {
    test('boost button gets btn-error class when there is a boost error', () => {
        mockBoostState.error = 'Boost failed';
        render(
            <EntryBadge
                timezone="local"
                {...noCallbacks}
                entry={baseEntry()}
                challengeId={777}
                boostAvailable={true}
                turboAvailable={false}
            />,
        );
        const button = screen.getByRole('button', { name: /🚀/ });
        const tokens = button.className.split(/\s+/);
        expect(tokens).toContain('btn-error');
        expect(tokens).not.toContain('btn-success');
    });

    test('turbo button gets btn-error class when there is a turbo error', () => {
        mockTurboState.error = 'Turbo failed';
        render(
            <EntryBadge
                timezone="local"
                {...noCallbacks}
                entry={baseEntry()}
                challengeId={777}
                boostAvailable={false}
                turboAvailable={true}
            />,
        );
        const tokens = screen.getByRole('button', { name: /⚡/ }).className.split(/\s+/);
        expect(tokens).toContain('btn-error');
        expect(tokens).not.toContain('btn-warning');
    });

    test('turbo button gets solid btn-warning when there is no error', () => {
        render(
            <EntryBadge
                timezone="local"
                {...noCallbacks}
                entry={baseEntry()}
                challengeId={777}
                boostAvailable={false}
                turboAvailable={true}
            />,
        );
        const tokens = screen.getByRole('button').className.split(/\s+/);
        expect(tokens).toContain('btn-warning');
        expect(tokens).not.toContain('btn-outline');
        expect(tokens).not.toContain('btn-error');
    });

    test('boost button gets solid btn-success when there is no error', () => {
        render(
            <EntryBadge
                timezone="local"
                {...noCallbacks}
                entry={baseEntry()}
                challengeId={777}
                boostAvailable={true}
                turboAvailable={false}
            />,
        );
        const button = screen.getByRole('button');
        const tokens = button.className.split(/\s+/);
        expect(tokens).toContain('btn-success');
        expect(tokens).not.toContain('btn-outline');
        expect(tokens).not.toContain('btn-error');
    });
});

describe('EntryBadge — layout: an info row, then an actions row', () => {
    const renderBadge = (props = {}) =>
        render(
            <EntryBadge
                timezone="local"
                {...noCallbacks}
                entry={baseEntry({ appEntered: { at: 1_792_420_000, exact: true } })}
                challengeId={777}
                boostAvailable={false}
                turboAvailable={false}
                {...props}
            />,
        );
    const badge = (container: Element) => container.firstElementChild!;

    test('the badge is a left-aligned column, its rows 8px apart', () => {
        const { container } = renderBadge();
        const { classList } = badge(container);
        // A bordered box, not a repurposed daisyUI badge.
        for (const cls of ['rounded-box', 'border', 'border-base-300', 'p-2']) {
            expect(classList.contains(cls)).toBe(true);
        }
        expect(classList.contains('badge')).toBe(false);
        for (const cls of ['flex', 'flex-col', 'items-start', 'text-left', 'gap-2']) {
            expect(classList.contains(cls)).toBe(true);
        }
        // Nothing that undoes it: the stock centring and the narrower gap.
        for (const cls of ['items-center', 'justify-center', 'gap-1', 'flex-wrap']) {
            expect(classList.contains(cls)).toBe(false);
        }
    });

    test('the info row holds the rank and when it went in; the actions row holds the buttons', () => {
        const { container } = renderBadge({ boostAvailable: true, turboAvailable: true, swapAvailable: true });
        const [info, actions] = Array.from(badge(container).children);
        expect(info.classList.contains('flex-wrap')).toBe(true);
        expect(info.textContent).toContain('app.rank');
        expect(info.textContent).toContain('app.entrySubmitted');
        expect(info.querySelector('button')).toBeNull();
        expect(actions.classList.contains('flex-wrap')).toBe(true);
        expect(actions.classList.contains('gap-2')).toBe(true);
        const labels = Array.from(actions.querySelectorAll('button')).map((button) => button.textContent);
        expect(labels).toEqual([
            expect.stringContaining('app.boost'),
            expect.stringContaining('app.turbo'),
            expect.stringContaining('app.currencySwap'),
            expect.stringContaining('app.swapPick'),
        ]);
        expect(actions.textContent).not.toContain('app.rank');
    });

    describe('the Guru-picked badge', () => {
        test('a guru-picked entry shows the badge instead of the ⭐ icon, never both', () => {
            const { container } = renderBadge({ entry: baseEntry({ guru_pick: true }) });
            const info = badge(container).firstElementChild!;
            expect(info.textContent).toContain('app.entryGuruPicked');
            const infoBadge = info.querySelector('.badge')!;
            expect(infoBadge.textContent).toContain('⭐');
            expect(infoBadge.classList.contains('badge-info')).toBe(true);
            // The standalone icon span is gone with it.
            expect(
                Array.from(info.children).some(
                    (child) => child.textContent === '⭐' && !child.classList.contains('badge'),
                ),
            ).toBe(false);
        });

        test('a plain entry shows neither the badge nor a Guru-picked label', () => {
            const { container } = renderBadge();
            const info = badge(container).firstElementChild!;
            expect(info.querySelector('.badge-info')).toBeNull();
            expect(info.textContent).not.toContain('app.entryGuruPicked');
        });

        test('a boosted entry that also carries a pick keeps its 🚀 icon and gains the badge', () => {
            const { container } = renderBadge({ entry: baseEntry({ boosted: true, guru_pick: true }) });
            const boostedInfo = badge(container).firstElementChild!;
            expect(boostedInfo.textContent).toContain('🚀');
            const infoBadge = boostedInfo.querySelector('.badge-info')!;
            expect(infoBadge.textContent).toContain('app.entryGuruPicked');
        });
    });

    test('the Swap button is told about a guru pick through its warnings', async () => {
        const onChooseSwap = jest.fn();
        renderBadge({
            entry: baseEntry({ guru_pick: true }),
            swapAvailable: true,
            onChooseSwap,
        });
        fireEvent.click(screen.getByText(/app\.swapPick$/).closest('button')!);
        await act(async () => {});
        expect(onChooseSwap).toHaveBeenCalledWith(
            expect.objectContaining({ guru_pick: true }),
            expect.objectContaining({ guruPick: true }),
            expect.anything(),
        );
    });

    test('the swap-back button is in the actions row beside Swap', () => {
        const { container } = renderBadge({
            swapAvailable: true,
            swapBack: { currentId: 'e1', previousId: 'old', previousMemberId: 'm', kind: 'boost' },
        });
        const actions = badge(container).children[1];
        const labels = Array.from(actions.querySelectorAll('button')).map((button) => button.textContent);
        expect(labels).toEqual([
            expect.stringContaining('app.currencySwap'),
            expect.stringContaining('app.swapPick'),
            expect.stringContaining('app.currencySwapBack'),
        ]);
    });

    test('no actions row renders when no action is available', () => {
        const { container } = renderBadge();
        expect(badge(container).children).toHaveLength(1);
        expect(container.querySelector('button')).toBeNull();
    });

    test('a failed action’s message stays below both rows', () => {
        mockBoostState.error = 'Boost failed';
        const { container } = renderBadge({ boostAvailable: true });
        const children = Array.from(badge(container).children);
        expect(children).toHaveLength(3);
        expect(children[2].getAttribute('role')).toBe('alert');
    });
});
