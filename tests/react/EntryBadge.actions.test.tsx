/**
 * EntryBadge per-entry Boost / Turbo actions through the real useBoost /
 * useTurbo hooks (window.api mocks): the apply IPC gets the challenge + entry
 * ids, success notifies the parent, failure surfaces the error instead.
 */

import { render, screen, fireEvent, waitFor } from './helpers/test-utils';
import { EntryBadge } from '@/components/app/EntryBadge';
import type { WindowApi } from '../../src/js/types/ipc';
import type { SwapBackOffer } from '@/api/useSwapBacks';
import { invalid } from '../helpers/invalid';

const entry = { id: 'e1', rank: 3, votes: 42, boosted: false, turbo: false };

const renderBadge = () => {
    const onBoostApplied = jest.fn();
    const onTurboApplied = jest.fn();
    render(
        <EntryBadge
            entry={entry}
            challengeId={7}
            boostAvailable
            turboAvailable
            onBoostApplied={onBoostApplied}
            onTurboApplied={onTurboApplied}
            onSwapped={() => {}}
        />,
    );
    return { onBoostApplied, onTurboApplied };
};

beforeEach(() => {
    (window.api as { applyBoost: WindowApi['applyBoost'] }).applyBoost = jest.fn().mockResolvedValue({ success: true });
    (window.api as { applyTurbo: WindowApi['applyTurbo'] }).applyTurbo = jest.fn().mockResolvedValue({ success: true });
});

test('boost applies to this entry and notifies the parent', async () => {
    const { onBoostApplied, onTurboApplied } = renderBadge();
    fireEvent.click(screen.getByText(/app\.boost/));
    await waitFor(() => expect(onBoostApplied).toHaveBeenCalledTimes(1));
    expect(window.api.applyBoost).toHaveBeenCalledWith(7, 'e1');
    expect(onTurboApplied).not.toHaveBeenCalled();
});

test('turbo applies to this entry and notifies the parent', async () => {
    const { onBoostApplied, onTurboApplied } = renderBadge();
    fireEvent.click(screen.getByText(/app\.turbo/));
    await waitFor(() => expect(onTurboApplied).toHaveBeenCalledTimes(1));
    expect(window.api.applyTurbo).toHaveBeenCalledWith(7, 'e1');
    expect(onBoostApplied).not.toHaveBeenCalled();
});

test('a failed boost shows the error and does not notify', async () => {
    (window.api as { applyBoost: WindowApi['applyBoost'] }).applyBoost = jest
        .fn()
        .mockResolvedValue({ success: false, error: 'boost gone' });
    const { onBoostApplied } = renderBadge();
    fireEvent.click(screen.getByText(/app\.boost/));
    await waitFor(() => expect(screen.getByText('boost gone')).toBeTruthy());
    expect(onBoostApplied).not.toHaveBeenCalled();
});

test('a failed turbo shows the error and does not notify', async () => {
    (window.api as { applyTurbo: WindowApi['applyTurbo'] }).applyTurbo = jest
        .fn()
        .mockResolvedValue({ success: false, error: 'turbo gone' });
    const { onTurboApplied } = renderBadge();
    fireEvent.click(screen.getByText(/app\.turbo/));
    await waitFor(() => expect(screen.getByText('turbo gone')).toBeTruthy());
    expect(onTurboApplied).not.toHaveBeenCalled();
});

describe('swap controls', () => {
    const renderSwap = (swapBack: SwapBackOffer | null) =>
        render(
            <EntryBadge
                entry={entry}
                challengeId={7}
                boostAvailable={false}
                turboAvailable={false}
                onBoostApplied={jest.fn()}
                onTurboApplied={jest.fn()}
                swapAvailable
                bankroll={invalid({ swaps: 2 })}
                onSwapped={jest.fn()}
                swapBack={swapBack}
            />,
        );

    test('Swap without an offer shows no Swap back', () => {
        renderSwap(null);
        expect(screen.getByText(/app\.currencySwap$/)).toBeTruthy();
        expect(screen.queryByText(/app\.currencySwapBack$/)).toBeNull();
    });

    test('a swap-back offer adds the Swap back button', () => {
        renderSwap({ currentId: 'e1', previousId: 'p', previousMemberId: 'm', kind: 'boost' });
        expect(screen.getByText(/app\.currencySwapBack$/)).toBeTruthy();
    });
});
