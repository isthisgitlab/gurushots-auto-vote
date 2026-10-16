/**
 * Tests for the per-entry Swap flow: preview (spends nothing, button spins) →
 * confirm modal with labelled current/replacement photos → swap exactly the
 * previewed photo. A swap that can't happen is reported inline with no modal.
 */

import { act, render, screen, fireEvent, waitFor } from './helpers/test-utils';
import { SwapEntryButton, SwapBackButton } from '@/components/app/SwapEntryButton';
import type { OpenSwapPick } from '@/components/app/SwapEntryButton';
import type { SwapBackOffer } from '@/api/useSwapBacks';
import { mockTranslator } from './helpers/setup';

const ENTRY = { id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', member_id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' };
const CANDIDATE = { id: 'cccccccccccccccccccccccccccccccc', member_id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' };

const renderButton = (props = {}) => {
    const onSpent = jest.fn();
    const onChoose = jest.fn<void, Parameters<OpenSwapPick>>();
    render(
        <SwapEntryButton
            entry={ENTRY}
            challengeId={7}
            bankroll={{ keys: 0, swaps: 4, fills: 0, coins: 0 }}
            warnActioned={false}
            onSpent={onSpent}
            onChoose={onChoose}
            {...props}
        />,
    );
    return { onSpent, onChoose };
};

const swapButton = () => screen.getByText(/app\.currencySwap$/).closest('button')!;

beforeEach(() => {
    window.api.previewSwapPhoto = jest.fn().mockResolvedValue({ success: true, outcome: 'ok', candidate: CANDIDATE });
    window.api.swapEntryPhoto = jest.fn().mockResolvedValue({ success: true, outcome: 'ok' });
});

test('preview spends nothing and shows the labelled current / replacement photos', async () => {
    renderButton();
    fireEvent.click(swapButton());
    expect(await screen.findByText('app.currencySwapTitle')).toBeTruthy();
    expect(window.api.previewSwapPhoto).toHaveBeenCalledWith(7, ENTRY.id, undefined);
    expect(window.api.swapEntryPhoto).not.toHaveBeenCalled();
    expect(screen.getByAltText('app.currencySwapCurrent')).toBeTruthy();
    expect(screen.getByAltText('app.currencySwapReplacement')).toBeTruthy();
});

test("the Swap button and its confirm modal's Spend are carmine", async () => {
    renderButton();
    expect(swapButton().className).toContain('btn-latvian');
    fireEvent.click(swapButton());
    await screen.findByText('app.currencySwapTitle');
    expect(screen.getByText('app.currencySpend').closest('button')!.className).toContain('btn-latvian');
});

test('the button spins while the preview is in flight', async () => {
    let resolve: ((value: Awaited<ReturnType<Window['api']['previewSwapPhoto']>>) => void) | undefined;
    window.api.previewSwapPhoto = jest.fn(() => new Promise((r) => (resolve = r)));
    renderButton();
    const button = swapButton();
    fireEvent.click(button);
    await waitFor(() => expect(button.disabled).toBe(true));
    resolve!({ success: true, outcome: 'ok', candidate: CANDIDATE });
    await screen.findByText('app.currencySwapTitle');
});

test('Spend swaps exactly the previewed photo with confirmed=true', async () => {
    const { onSpent } = renderButton();
    fireEvent.click(swapButton());
    fireEvent.click(await screen.findByText('app.currencySpend'));
    await waitFor(() => expect(onSpent).toHaveBeenCalledTimes(1));
    expect(window.api.swapEntryPhoto).toHaveBeenCalledWith(7, ENTRY.id, CANDIDATE.id, true);
});

test('no alternative: the card swap picker opens with the reason; no modal, no inline error', async () => {
    window.api.previewSwapPhoto = jest
        .fn()
        .mockResolvedValue({ success: false, outcome: 'no-alternative', error: 'no-alternative' });
    const { onChoose } = renderButton({ warnActioned: true, warnPinned: 'turbo' });
    fireEvent.click(swapButton());
    await waitFor(() => expect(onChoose).toHaveBeenCalledTimes(1));
    expect(onChoose).toHaveBeenCalledWith(
        ENTRY,
        { actioned: true, pinned: 'turbo' },
        swapButton(),
        'app.swapPickNoSuggestion',
    );
    expect(screen.queryByText('app.currencySwapTitle')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(swapButton().className).not.toContain('btn-error');
});

test('Choose another photo… closes the suggestion and hands over to the card picker', async () => {
    const { onChoose, onSpent } = renderButton({ warnPinned: 'boost' });
    fireEvent.click(swapButton());
    fireEvent.click(await screen.findByText('app.currencySwapChoose'));
    await waitFor(() => expect(screen.queryByText('app.currencySwapTitle')).toBeNull());
    expect(onChoose).toHaveBeenCalledWith(ENTRY, { actioned: false, pinned: 'boost' }, swapButton());
    expect(window.api.swapEntryPhoto).not.toHaveBeenCalled();
    expect(onSpent).not.toHaveBeenCalled();
});

test('Choose another photo… clears an earlier failure under the button', async () => {
    window.api.swapEntryPhoto = jest
        .fn()
        .mockResolvedValue({ success: false, outcome: 'stale-candidate', error: 'stale-candidate' });
    const { onChoose } = renderButton();
    fireEvent.click(swapButton());
    fireEvent.click(await screen.findByText('app.currencySpend'));
    expect(await screen.findByText('app.currencyOutcomeStaleCandidate')).toBeTruthy();
    fireEvent.click(swapButton());
    fireEvent.click(await screen.findByText('app.currencySwapChoose'));
    expect(onChoose).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('app.currencyOutcomeStaleCandidate')).toBeNull();
});

test('a failed swap stays until dismissed — no timer clears it — and a new attempt starts clean', async () => {
    jest.useFakeTimers();
    try {
        window.api.previewSwapPhoto = jest
            .fn()
            .mockResolvedValueOnce({ success: false, outcome: 'api-failed', error: 'api-failed' })
            .mockResolvedValueOnce({ success: true, outcome: 'ok', candidate: CANDIDATE });
        renderButton();
        fireEvent.click(swapButton());
        await act(async () => {
            await Promise.resolve();
        });
        expect(screen.getByRole('alert').textContent).toContain('app.currencyOutcomeFailed');

        act(() => jest.advanceTimersByTime(60_000));
        expect(screen.getByRole('alert')).toBeTruthy();

        fireEvent.click(screen.getByRole('button', { name: 'errors.dismiss' }));
        expect(screen.queryByRole('alert')).toBeNull();
    } finally {
        jest.useRealTimers();
    }
});

test('stale candidate on commit: modal closes and the reason is shown', async () => {
    window.api.swapEntryPhoto = jest
        .fn()
        .mockResolvedValue({ success: false, outcome: 'stale-candidate', error: 'stale-candidate' });
    const { onSpent } = renderButton();
    fireEvent.click(swapButton());
    fireEvent.click(await screen.findByText('app.currencySpend'));
    expect(await screen.findByText('app.currencyOutcomeStaleCandidate')).toBeTruthy();
    expect(screen.queryByText('app.currencySwapTitle')).toBeNull();
    expect(onSpent).not.toHaveBeenCalled();
});

test('warns when the entry is boosted or turbo-charged', async () => {
    renderButton({ warnActioned: true });
    fireEvent.click(swapButton());
    expect(await screen.findByText('app.currencySwapBoostedWarning')).toBeTruthy();
});

test('a not-available commit still refreshes (the state moved under us)', async () => {
    window.api.swapEntryPhoto = jest
        .fn()
        .mockResolvedValue({ success: false, outcome: 'not-available', error: 'not-available' });
    const { onSpent } = renderButton();
    fireEvent.click(swapButton());
    fireEvent.click(await screen.findByText('app.currencySpend'));
    await waitFor(() => expect(onSpent).toHaveBeenCalledTimes(1));
});

test('an already-entered commit refreshes too: the card still offered that photo', async () => {
    window.api.swapEntryPhoto = jest
        .fn()
        .mockResolvedValue({ success: false, outcome: 'already-entered', error: 'already-entered' });
    const { onSpent } = renderButton();
    fireEvent.click(swapButton());
    fireEvent.click(await screen.findByText('app.currencySpend'));
    await waitFor(() => expect(onSpent).toHaveBeenCalledTimes(1));
});

test('Cancel closes the confirm modal without swapping', async () => {
    const { onSpent } = renderButton();
    fireEvent.click(swapButton());
    fireEvent.click(await screen.findByText('app.cancel'));
    await waitFor(() => expect(screen.queryByText('app.currencySwapTitle')).toBeNull());
    expect(window.api.swapEntryPhoto).not.toHaveBeenCalled();
    expect(onSpent).not.toHaveBeenCalled();
});

describe('SwapBackButton', () => {
    const SWAP_BACK: Pick<SwapBackOffer, 'previousId' | 'previousMemberId' | 'kind'> = {
        previousId: 'dddddddddddddddddddddddddddddddd',
        previousMemberId: ENTRY.member_id,
        kind: 'boost',
    };

    const renderSwapBack = (swapBack = SWAP_BACK) => {
        const onSpent = jest.fn();
        render(
            <SwapBackButton
                entry={ENTRY}
                swapBack={swapBack}
                challengeId={7}
                bankroll={{ keys: 0, swaps: 4, fills: 0, coins: 0 }}
                onSpent={onSpent}
            />,
        );
        return { onSpent };
    };

    beforeEach(() => {
        window.api.swapBackEntryPhoto = jest.fn().mockResolvedValue({ success: true, outcome: 'ok' });
    });

    test('confirm modal shows the current photo and the original, then swaps back', async () => {
        const { onSpent } = renderSwapBack();
        fireEvent.click(screen.getByText(/app\.currencySwapBack$/));
        expect(screen.getByText('app.currencySwapBackTitle')).toBeTruthy();
        expect(screen.getByAltText('app.currencySwapBackOriginal')).toBeTruthy();
        fireEvent.click(screen.getByText('app.currencySpend'));
        await waitFor(() => expect(onSpent).toHaveBeenCalledTimes(1));
        expect(window.api.swapBackEntryPhoto).toHaveBeenCalledWith(7, ENTRY.id, true);
    });

    test('the Swap back button is carmine until a failure turns it red', async () => {
        window.api.swapBackEntryPhoto = jest.fn().mockResolvedValue({ success: false, outcome: 'failed' });
        renderSwapBack();
        const button = screen.getByText(/app\.currencySwapBack$/).closest('button')!;
        expect(button.className).toContain('btn-latvian');
        fireEvent.click(button);
        fireEvent.click(screen.getByText('app.currencySpend'));
        await screen.findByRole('alert');
        expect(button.className).toContain('btn-error');
        expect(button.className).not.toContain('btn-latvian');
    });

    test('Cancel spends nothing', () => {
        renderSwapBack();
        fireEvent.click(screen.getByText(/app\.currencySwapBack$/));
        fireEvent.click(screen.getByText('app.cancel'));
        expect(window.api.swapBackEntryPhoto).not.toHaveBeenCalled();
    });

    test('names the turbo kind in the body for a turbo swap back', () => {
        mockTranslator.t.mockImplementation((key) => (key === 'app.turbo' ? 'TURBO' : key));
        try {
            renderSwapBack({ ...SWAP_BACK, kind: 'turbo' });
            fireEvent.click(screen.getByText(/app\.currencySwapBack$/));
            expect(mockTranslator.t).toHaveBeenCalledWith('app.turbo', expect.anything());
            expect(mockTranslator.t).not.toHaveBeenCalledWith('app.boost', expect.anything());
        } finally {
            mockTranslator.t.mockImplementation((key) => key);
        }
    });

    test('a not-available outcome refreshes and flags the button', async () => {
        window.api.swapBackEntryPhoto = jest
            .fn()
            .mockResolvedValue({ success: false, outcome: 'not-available', error: 'not-available' });
        const { onSpent } = renderSwapBack();
        fireEvent.click(screen.getByText(/app\.currencySwapBack$/));
        fireEvent.click(screen.getByText('app.currencySpend'));
        await waitFor(() => expect(onSpent).toHaveBeenCalledTimes(1));
        expect(screen.getByRole('alert')).toBeTruthy();
        expect(screen.getByText(/app\.currencySwapBack$/).closest('button')!.className).toContain('btn-error');
    });

    test('Dismiss clears a swap-back failure', async () => {
        window.api.swapBackEntryPhoto = jest.fn().mockResolvedValue({ success: false, outcome: 'failed' });
        renderSwapBack();
        fireEvent.click(screen.getByText(/app\.currencySwapBack$/));
        fireEvent.click(screen.getByText('app.currencySpend'));
        await screen.findByRole('alert');
        fireEvent.click(screen.getByRole('button', { name: 'errors.dismiss' }));
        expect(screen.queryByRole('alert')).toBeNull();
    });

    test('a plain failure shows the reason without refreshing', async () => {
        window.api.swapBackEntryPhoto = jest.fn().mockResolvedValue({ success: false, outcome: 'failed' });
        const { onSpent } = renderSwapBack();
        fireEvent.click(screen.getByText(/app\.currencySwapBack$/));
        fireEvent.click(screen.getByText('app.currencySpend'));
        await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
        expect(onSpent).not.toHaveBeenCalled();
    });
});
