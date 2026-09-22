/**
 * Tests for the bankroll-currency buttons on the full ChallengeCard: Key
 * (unlock boost, in the Boost cell) and Fill exposure (in the Exposure cell).
 * Visibility follows the shared predicates (balance + challenge flags); every
 * spend goes through the confirm modal, and a successful spend refreshes the
 * balance + challenges via onCurrencySpent.
 */

import { render, screen, fireEvent, waitFor } from './helpers/test-utils';
import { ChallengeCard } from '@/components/app/ChallengeCard';
import { buildChallenge } from '../helpers/challengeFixtures';

const mockChallengeSettings = {
    hasCustomSettings: false,
    autoFillEnabled: false,
    isCompact: false,
    hasCompactOverride: false,
    toggleCompact: jest.fn(),
};

jest.mock('@/hooks/useChallengeSettings', () => ({
    useChallengeSettings: () => mockChallengeSettings,
}));
jest.mock('@/api/useTurbo', () => ({
    useTurbo: () => ({ playAutoTurbo: jest.fn(), loading: false, error: null, clearError: jest.fn() }),
}));
jest.mock('@/api/useFillChallenge', () => ({
    useFillChallenge: () => ({ fillNow: jest.fn(), loading: false, error: null, clearError: jest.fn() }),
}));
jest.mock('@/components/app/VoteButton', () => ({ VoteButton: () => null }));
jest.mock('@/components/app/RunButton', () => ({ RunButton: () => null }));
jest.mock('@/components/app/EntryBadge', () => ({ EntryBadge: () => null }));

const FULL = { keys: 3, swaps: 2, fills: 5, coins: 0 };

const makeChallenge = ({ boostState = 'LOCKED', exposure = 40, fillLocked = false } = {}) => {
    const nowSec = Math.floor(Date.now() / 1000);
    return buildChallenge({
        id: 101,
        title: 'Sunset',
        url: 'sunset',
        type: undefined,
        max_photo_submits: 1,
        start_time: nowSec - 3600,
        close_time: nowSec + 3600,
        entries: 100,
        players: 50,
        votes: 2000,
        prizes_worth: '$100',
        tags: [],
        welcome_message: '',
        boost_enable: true,
        fill_enable: true,
        fill_locked: fillLocked,
        swap_enable: true,
        swap_locked: false,
        member: {
            boost: { state: boostState, timeout: null },
            turbo: { state: 'UNAVAILABLE', time_to_open: null },
            ranking: {
                exposure: { exposure_factor: exposure },
                total: { votes: 0, rank: 0, level: 0, percent: 0, next_message: '' },
            },
        },
    });
};

const renderCard = (challenge, { bankroll = FULL, autovoteRunning = false, onCurrencySpent = jest.fn() } = {}) => {
    render(
        <ChallengeCard
            challenge={challenge}
            timeRemaining="2h"
            timezone="local"
            autovoteRunning={autovoteRunning}
            onVoteComplete={jest.fn()}
            onSettingsClick={jest.fn()}
            bankroll={bankroll}
            onCurrencySpent={onCurrencySpent}
        />,
    );
    return { onCurrencySpent };
};

const keyButton = () => screen.queryByText(/app\.currencyKeyUnlock$/);
const fillButton = () => screen.queryByText(/app\.currencyFillExposure$/);

beforeEach(() => {
    window.api.keyUnlockBoost = jest.fn().mockResolvedValue({ success: true, outcome: 'ok' });
    window.api.fillExposure = jest.fn().mockResolvedValue({ success: true, outcome: 'ok' });
});

describe('visibility', () => {
    test('both shown when the balance and the challenge allow them', () => {
        renderCard(makeChallenge());
        expect(keyButton()).toBeTruthy();
        expect(fillButton()).toBeTruthy();
    });

    test('hidden when the balance is unreadable', () => {
        renderCard(makeChallenge(), { bankroll: null });
        expect(keyButton()).toBeNull();
        expect(fillButton()).toBeNull();
    });

    test('hidden at zero balance', () => {
        renderCard(makeChallenge(), { bankroll: { ...FULL, keys: 0, fills: 0 } });
        expect(keyButton()).toBeNull();
        expect(fillButton()).toBeNull();
    });

    test('Key hidden once the boost is no longer LOCKED; Fill hidden at 100% or when locked', () => {
        renderCard(makeChallenge({ boostState: 'AVAILABLE_KEY', exposure: 100 }));
        expect(keyButton()).toBeNull();
        expect(fillButton()).toBeNull();
    });

    test('disabled while autovote runs', () => {
        renderCard(makeChallenge(), { autovoteRunning: true });
        expect(keyButton().closest('button').disabled).toBe(true);
    });
});

describe('confirm flow', () => {
    test('Cancel spends nothing', () => {
        renderCard(makeChallenge());
        fireEvent.click(keyButton());
        expect(screen.getByText('app.currencyKeyUnlockTitle')).toBeTruthy();
        fireEvent.click(screen.getByText('common.cancel'));
        expect(window.api.keyUnlockBoost).not.toHaveBeenCalled();
    });

    test('Spend unlocks with confirmed=true and refreshes balance + challenges', async () => {
        const { onCurrencySpent } = renderCard(makeChallenge());
        fireEvent.click(keyButton());
        fireEvent.click(screen.getByText('app.currencySpend'));
        await waitFor(() => expect(onCurrencySpent).toHaveBeenCalledTimes(1));
        expect(window.api.keyUnlockBoost).toHaveBeenCalledWith(101, true);
    });

    test('Spend is disabled from the first click until the spend settles', async () => {
        let resolve;
        window.api.fillExposure = jest.fn(() => new Promise((r) => (resolve = r)));
        renderCard(makeChallenge());
        fireEvent.click(fillButton());
        const spend = screen.getByText('app.currencySpend').closest('button');
        fireEvent.click(spend);
        await waitFor(() => expect(spend.disabled).toBe(true));
        fireEvent.click(spend);
        expect(window.api.fillExposure).toHaveBeenCalledTimes(1);
        resolve({ success: true, outcome: 'ok' });
        await waitFor(() => expect(screen.queryByText('app.currencyFillExposureTitle')).toBeNull());
    });

    test('a failed spend shows the translated outcome, not a raw code', async () => {
        window.api.fillExposure = jest.fn().mockResolvedValue({ success: false, outcome: 'busy', error: 'busy' });
        const { onCurrencySpent } = renderCard(makeChallenge());
        fireEvent.click(fillButton());
        fireEvent.click(screen.getByText('app.currencySpend'));
        expect(await screen.findByText('app.currencyOutcomeBusy')).toBeTruthy();
        expect(onCurrencySpent).not.toHaveBeenCalled();
    });

    test('the modal shows the balance before → after', () => {
        renderCard(makeChallenge());
        fireEvent.click(keyButton());
        // t() returns keys in tests, so the interpolated line is the key itself.
        expect(screen.getByText('app.currencyBalance')).toBeTruthy();
    });
});
