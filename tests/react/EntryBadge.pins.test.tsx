/**
 * EntryBadge's pin toggles: a fixed-name button per feature with aria-pressed carrying the state, shown
 * only while its feature can still fire and never on a photo that carries the other feature, grouped
 * apart from the spend buttons. The Swap confirm names a live pin.
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
    onToggle: jest.fn(),
    ...overrides,
});

const renderBadge = (pin?: EntryPinControls, props = {}) =>
    render(
        <EntryBadge
            entry={entry()}
            challengeId={7}
            boostAvailable={false}
            turboAvailable={false}
            onBoostApplied={() => {}}
            onTurboApplied={() => {}}
            onSwapped={() => {}}
            pin={pin}
            {...props}
        />,
    );

const pinBoost = () => screen.queryByRole('button', { name: /app\.pinForBoost/ });
const pinTurbo = () => screen.queryByRole('button', { name: /app\.pinForTurbo/ });

describe('EntryBadge pin toggles', () => {
    test('no pin controls, no toggles', () => {
        renderBadge();
        expect(pinBoost()).toBeNull();
        expect(pinTurbo()).toBeNull();
    });

    test('both toggles show with a fixed name and text label, unpressed by default', () => {
        renderBadge(controls());
        expect(pinBoost()!.getAttribute('aria-pressed')).toBe('false');
        expect(pinTurbo()!.getAttribute('aria-pressed')).toBe('false');
        expect(pinBoost()!.textContent).toContain('app.pinForBoost');
    });

    test('aria-pressed follows the stored pin, and the pressed button is filled rather than outlined', () => {
        renderBadge(controls({ pins: { boost: 'e1', turbo: 'other' } }));
        expect(pinBoost()!.getAttribute('aria-pressed')).toBe('true');
        expect(pinBoost()!.className).not.toContain('btn-outline');
        expect(pinTurbo()!.getAttribute('aria-pressed')).toBe('false');
        expect(pinTurbo()!.className).toContain('btn-outline');
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

    test('the toggles sit in their own group apart from the Boost button', () => {
        renderBadge(controls(), { boostAvailable: true });
        const group = pinBoost()!.parentElement!;
        expect(group.className).toContain('ml-2');
        expect(group.contains(screen.getByRole('button', { name: /🚀/ }))).toBe(false);
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
