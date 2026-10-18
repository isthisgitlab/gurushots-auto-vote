/**
 * EntryBadge's pin toggles: a fixed-name button per feature with aria-pressed carrying the state, shown
 * only while its feature can still fire and never on a photo that carries the other feature. They share the
 * actions row with the spend buttons, 8px apart by its gap. The Swap confirm names a live pin.
 */

import { fireEvent, render, screen, waitFor } from './helpers/test-utils';
import { EntryBadge } from '@/components/app/EntryBadge';
import type { EntryPinControls } from '@/components/app/EntryBadge';

jest.mock('@/api/useBoost', () => ({
    useBoost: () => ({ applyBoost: jest.fn(), loading: false, error: null, clearError: jest.fn() }),
}));
jest.mock('@/api/useTurbo', () => ({
    useTurbo: () => ({ applyTurbo: jest.fn(), loading: false, error: null, clearError: jest.fn() }),
}));

const entry = (overrides = {}) => ({ id: 'e1', rank: 3, votes: 42, boosted: false, turbo: false, ...overrides });

const controls = (overrides: Partial<EntryPinControls> = {}): EntryPinControls => ({
    pins: { boost: null, turbo: null },
    canPin: { boost: true, turbo: true },
    livePin: null,
    busy: false,
    onToggle: jest.fn(),
    ...overrides,
});

const renderBadge = (pin?: EntryPinControls, props = {}) =>
    render(
        <EntryBadge
            timezone="local"
            entry={entry()}
            challengeId={7}
            boostAvailable={false}
            turboAvailable={false}
            onBoostApplied={() => {}}
            onTurboApplied={() => {}}
            onSwapped={() => {}}
            onChooseSwap={() => {}}
            pin={pin}
            {...props}
        />,
    );

const classTokens = (el: Element | null) => (el?.className ?? '').split(/\s+/);
const COLOUR_VARIANTS = [
    'btn-neutral',
    'btn-primary',
    'btn-secondary',
    'btn-accent',
    'btn-info',
    'btn-success',
    'btn-warning',
    'btn-error',
    'btn-latvian',
];

const pinBoost = () => screen.queryByRole('button', { name: /app\.pinForBoost/ });
const pinTurbo = () => screen.queryByRole('button', { name: /app\.pinForTurbo/ });

describe('EntryBadge pin toggles', () => {
    test('no pin controls, no toggles', () => {
        renderBadge();
        expect(pinBoost()).toBeNull();
        expect(pinTurbo()).toBeNull();
    });

    test('while a pin write is in flight both toggles are aria-disabled and busy, ignore a press, and idle otherwise', () => {
        const onToggle = jest.fn();
        const { unmount } = renderBadge(controls({ busy: true, onToggle }));
        for (const toggle of [pinBoost(), pinTurbo()]) {
            expect(toggle!.getAttribute('aria-disabled')).toBe('true');
            expect(toggle!.getAttribute('aria-busy')).toBe('true');
            // Focusable still: `disabled` would drop the keyboard focus.
            expect((toggle as HTMLButtonElement).disabled).toBe(false);
            toggle!.focus();
            expect(document.activeElement).toBe(toggle);
            fireEvent.click(toggle!);
        }
        expect(onToggle).not.toHaveBeenCalled();
        unmount();
        renderBadge(controls({ onToggle }));
        expect(pinBoost()!.getAttribute('aria-disabled')).toBe('false');
        expect(pinBoost()!.getAttribute('aria-busy')).toBe('false');
        fireEvent.click(pinBoost()!);
        expect(onToggle).toHaveBeenCalledWith('boost', 'e1');
    });

    test('the buttons sit in a wrapping actions row, so six of them do not overflow a narrow screen', () => {
        renderBadge(controls(), { boostAvailable: true, swapAvailable: true });
        const row = pinBoost()!.parentElement!;
        expect(row.classList.contains('flex-wrap')).toBe(true);
        expect(row.classList.contains('gap-2')).toBe(true);
    });

    test('both toggles show with a fixed name and text label, unpressed by default', () => {
        renderBadge(controls());
        expect(pinBoost()!.getAttribute('aria-pressed')).toBe('false');
        expect(pinTurbo()!.getAttribute('aria-pressed')).toBe('false');
        expect(pinBoost()!.textContent).toContain('app.pinForBoost');
    });

    test('aria-pressed follows the stored pin, and the pressed button is filled rather than outlined', () => {
        renderBadge(controls({ pins: { boost: 'e1', turbo: 'other' } }));
        const boost = screen.getByRole('button', { name: /app\.pinnedForBoost/ });
        expect(boost.getAttribute('aria-pressed')).toBe('true');
        expect(classTokens(boost)).not.toContain('btn-outline');
        expect(pinTurbo()!.getAttribute('aria-pressed')).toBe('false');
        expect(classTokens(pinTurbo())).toContain('btn-outline');
    });

    test('a pressed pin is a solid theme colour: success for Boost, warning for Turbo', () => {
        renderBadge(controls({ pins: { boost: 'e1', turbo: 'e1' } }));
        const boost = classTokens(screen.getByRole('button', { name: /app\.pinnedForBoost/ }));
        const turbo = classTokens(screen.getByRole('button', { name: /app\.pinnedForTurbo/ }));
        expect(boost).toContain('btn-success');
        expect(boost).not.toContain('btn-warning');
        expect(turbo).toContain('btn-warning');
        expect(turbo).not.toContain('btn-success');
        for (const tokens of [boost, turbo]) expect(tokens).not.toContain('btn-outline');
    });

    test('an unpressed pin is a plain outline: no colour variant and no coloured border, so border and label stay base-content', () => {
        renderBadge(controls());
        for (const tokens of [classTokens(pinBoost()), classTokens(pinTurbo())]) {
            expect(tokens).toContain('btn-outline');
            expect(tokens.filter((c) => COLOUR_VARIANTS.includes(c) || /^border-(?:success|warning)$/.test(c))).toEqual(
                [],
            );
        }
    });

    test('no button is an outline combined with a colour variant, whatever the pin and spend state', () => {
        for (const pins of [
            { boost: null, turbo: null },
            { boost: 'e1', turbo: null },
            { boost: null, turbo: 'e1' },
            { boost: 'e1', turbo: 'e1' },
        ]) {
            const { container, unmount } = renderBadge(controls({ pins }), {
                boostAvailable: true,
                turboAvailable: true,
                swapAvailable: true,
            });
            for (const button of container.querySelectorAll('button')) {
                const tokens = classTokens(button);
                if (tokens.includes('btn-outline')) {
                    expect(tokens.filter((c) => COLOUR_VARIANTS.includes(c))).toEqual([]);
                }
            }
            unmount();
        }
    });

    test('a busy unpressed pin stays an outline with no coloured border, and gains btn-disabled', () => {
        renderBadge(controls({ busy: true }));
        const tokens = classTokens(pinBoost());
        expect(tokens).toEqual(expect.arrayContaining(['btn-outline', 'btn-disabled']));
        expect(tokens.some((c) => c.startsWith('border-'))).toBe(false);
    });

    test('a busy pressed pin stays solid in its colour and gains btn-disabled', () => {
        renderBadge(controls({ busy: true, pins: { boost: 'e1', turbo: 'e1' } }));
        const boost = classTokens(screen.getByRole('button', { name: /app\.pinnedForBoost/ }));
        const turbo = classTokens(screen.getByRole('button', { name: /app\.pinnedForTurbo/ }));
        expect(boost).toEqual(expect.arrayContaining(['btn-success', 'btn-disabled']));
        expect(turbo).toEqual(expect.arrayContaining(['btn-warning', 'btn-disabled']));
        expect(boost).not.toContain('btn-outline');
        expect(turbo).not.toContain('btn-outline');
    });

    test('the pressed button says "Pinned for …" in text, and that visible text is its accessible name', () => {
        renderBadge(controls({ pins: { boost: 'e1', turbo: 'other' } }));
        const pressed = screen.getByRole('button', { name: /app\.pinnedForBoost/ });
        expect(pressed.textContent).toContain('app.pinnedForBoost');
        expect(pressed.hasAttribute('aria-label')).toBe(false);
        expect(pressed.getAttribute('aria-pressed')).toBe('true');
        expect(pinTurbo()!.textContent).toContain('app.pinForTurbo');
        expect(pinTurbo()!.textContent).not.toContain('app.pinnedForTurbo');
    });

    test('pressing a toggle asks to pin (or clear) this photo for that feature', () => {
        const pin = controls();
        renderBadge(pin);
        fireEvent.click(pinBoost()!);
        fireEvent.click(pinTurbo()!);
        expect(pin.onToggle).toHaveBeenNthCalledWith(1, 'boost', 'e1');
        expect(pin.onToggle).toHaveBeenNthCalledWith(2, 'turbo', 'e1');
    });

    test('a feature that can no longer fire has no toggle', () => {
        const { unmount } = renderBadge(controls({ canPin: { boost: false, turbo: true } }));
        expect(pinBoost()).toBeNull();
        expect(pinTurbo()).not.toBeNull();
        unmount();
        renderBadge(controls({ canPin: { boost: true, turbo: false } }));
        expect(pinTurbo()).toBeNull();
    });

    test('nothing renders when neither feature can fire', () => {
        renderBadge(controls({ canPin: { boost: false, turbo: false } }));
        expect(pinBoost()).toBeNull();
        expect(pinTurbo()).toBeNull();
    });

    test('a photo that carries Turbo can’t be pinned for Boost, and one that carries Boost can’t be pinned for Turbo', () => {
        const { unmount } = renderBadge(controls(), { entry: entry({ turbo: true }) });
        expect(pinBoost()).toBeNull();
        expect(pinTurbo()).not.toBeNull();
        unmount();
        renderBadge(controls(), { entry: entry({ boosted: true }) });
        expect(pinTurbo()).toBeNull();
        expect(pinBoost()).not.toBeNull();
    });

    test('the toggles share the actions row with the Boost button, 8px apart, not beside the rank', () => {
        renderBadge(controls(), { boostAvailable: true });
        const row = pinBoost()!.parentElement!;
        expect(row.classList.contains('gap-2')).toBe(true);
        expect(row.contains(screen.getByRole('button', { name: /🚀/ }))).toBe(true);
        expect(row.contains(screen.getByText(/app\.rank/))).toBe(false);
    });

    test('no actions row renders when no toggle shows', () => {
        const { container } = renderBadge(controls({ canPin: { boost: false, turbo: false } }));
        expect(pinBoost()).toBeNull();
        expect(container.firstElementChild!.children).toHaveLength(1);
    });
});

describe('EntryBadge Swap warning for a live pin', () => {
    const swap = () => screen.getByText(/app\.currencySwap$/).closest('button')!;

    beforeEach(() => {
        window.api.previewSwapPhoto = jest
            .fn()
            .mockResolvedValue({ success: true, outcome: 'ok', candidate: { id: 'new1', member_id: 'm' } });
    });

    test.each(['boost', 'turbo'] as const)('names the pin for %s with its own text', async (livePin) => {
        renderBadge(controls({ livePin }), { swapAvailable: true });
        fireEvent.click(swap());
        await screen.findByText('app.currencySwapTitle');
        expect(screen.getByText('app.pinSwapWarning')).not.toBeNull();
        expect(screen.queryByText('app.currencySwapBoostedWarning')).toBeNull();
    });

    test('no pin, no pin warning', async () => {
        renderBadge(controls(), { swapAvailable: true });
        fireEvent.click(swap());
        await waitFor(() => expect(screen.getByText('app.currencySwapTitle')).not.toBeNull());
        expect(screen.queryByText(/app\.pinSwapWarning/)).toBeNull();
    });
});
