/**
 * Component tests for DiscoverSection: free joins call joinChallenge directly;
 * paid joins go through the confirm modal and only spend on confirm. The
 * translation manager returns keys verbatim in tests, so buttons are matched by
 * their i18n key text.
 */

import { render, screen, fireEvent, waitFor } from './helpers/test-utils';
import { DiscoverSection } from '@/components/app/DiscoverSection';
import { mockTranslator } from './helpers/setup';

const items = [
    { id: 900001, type: 'default', join_coins: 0, title: 'Free One' },
    { id: 900002, type: 'flash', join_coins: 100, title: 'Paid One' },
];

beforeEach(() => {
    window.api = {
        onSettingsChanged: undefined,
        getMemberChallenges: jest.fn().mockResolvedValue({ success: true, items }),
        joinChallenge: jest.fn().mockResolvedValue({ success: true, status: 'joined' }),
    };
});

test('renders collapsed by default with an open-count badge', async () => {
    const { container } = render(<DiscoverSection isLoggedIn bankroll={{ coins: 500 }} onJoined={jest.fn()} />);
    await screen.findByText('Free One');
    const details = container.querySelector('[data-testid="discover-section"]');
    // Compact + out of the way: a <details> that starts closed.
    expect(details.tagName.toLowerCase()).toBe('details');
    expect(details.hasAttribute('open')).toBe(false);
    // Summary shows the open-challenge count (2 fixtures).
    expect(screen.getByText('2')).toBeTruthy();
});

test('the count badge is hidden when there are no open challenges', async () => {
    window.api.getMemberChallenges = jest.fn().mockResolvedValue({ success: true, items: [] });
    render(<DiscoverSection isLoggedIn bankroll={{ coins: 500 }} onJoined={jest.fn()} />);
    await screen.findByText('app.discoverEmpty');
    expect(screen.queryByText('0')).toBeNull();
});

test('free join calls joinChallenge with spendCoins=false, no modal', async () => {
    render(<DiscoverSection isLoggedIn bankroll={{ coins: 500 }} onJoined={jest.fn()} />);
    await screen.findByText('Free One');
    const joinBtn = screen.getByText('app.discoverJoin');
    fireEvent.click(joinBtn);
    await waitFor(() => expect(window.api.joinChallenge).toHaveBeenCalledWith(900001, false));
    // No confirm modal for the free path.
    expect(screen.queryByText('app.discoverConfirmTitle')).toBeNull();
});

test('paid join opens the confirm modal and only spends on confirm', async () => {
    render(<DiscoverSection isLoggedIn bankroll={{ coins: 500 }} onJoined={jest.fn()} />);
    await screen.findByText('Paid One');
    fireEvent.click(screen.getByText('app.discoverJoinPaid'));

    // Modal appears; nothing charged yet.
    await screen.findByText('app.discoverConfirmTitle');
    expect(window.api.joinChallenge).not.toHaveBeenCalled();

    // Confirm → spends with spendCoins=true.
    fireEvent.click(screen.getByText('app.discoverConfirmSpend'));
    await waitFor(() => expect(window.api.joinChallenge).toHaveBeenCalledWith(900002, true));
});

test('a statusless failure (auth expiry / handler error) still shows a message', async () => {
    window.api.joinChallenge = jest.fn().mockResolvedValue({ success: false, error: 'No authentication token found' });
    render(<DiscoverSection isLoggedIn bankroll={{ coins: 500 }} onJoined={jest.fn()} />);
    await screen.findByText('Free One');
    fireEvent.click(screen.getByText('app.discoverJoin'));
    // No mapped status → falls back to the result's error text, never silent.
    await screen.findByText('No authentication token found');
});

test('confirm modal blocks the spend when the balance is short', async () => {
    render(<DiscoverSection isLoggedIn bankroll={{ coins: 50 }} onJoined={jest.fn()} />);
    await screen.findByText('Paid One');
    fireEvent.click(screen.getByText('app.discoverJoinPaid'));
    await screen.findByText('app.discoverConfirmTitle');
    // Insufficient message shown and the Spend button disabled.
    await screen.findByText('app.discoverConfirmInsufficient');
    const spendBtn = screen.getByText('app.discoverConfirmSpend');
    expect(spendBtn.disabled).toBe(true);
    expect(window.api.joinChallenge).not.toHaveBeenCalled();
});

test('charged-pending-submit shows the distinct message + retry action', async () => {
    window.api.joinChallenge = jest.fn().mockResolvedValue({ status: 'charged-pending-submit', cost: 100 });
    render(<DiscoverSection isLoggedIn bankroll={{ coins: 500 }} onJoined={jest.fn()} />);
    await screen.findByText('Paid One');
    fireEvent.click(screen.getByText('app.discoverJoinPaid'));
    await screen.findByText('app.discoverConfirmTitle');
    fireEvent.click(screen.getByText('app.discoverConfirmSpend'));
    // The distinct "charged but not joined" message and its retry button.
    await screen.findByText('app.discoverChargedPending');
    expect(screen.getByText('app.discoverRetrySubmit')).toBeTruthy();
});

describe('edge paths', () => {
    const renderSection = (props = {}) => {
        const onJoined = jest.fn();
        render(<DiscoverSection isLoggedIn bankroll={{ coins: 500 }} onJoined={onJoined} {...props} />);
        return { onJoined };
    };

    test('logged out renders nothing', () => {
        const { container } = render(<DiscoverSection isLoggedIn={false} bankroll={null} onJoined={jest.fn()} />);
        expect(container.firstChild).toBeNull();
    });

    test('a failed list fetch shows the error badge and message; Refresh refetches', async () => {
        window.api.getMemberChallenges = jest.fn().mockResolvedValue({ success: false, error: 'down' });
        renderSection();
        expect(await screen.findByText('app.discoverUnavailableList', { selector: 'p' })).toBeTruthy();
        expect(screen.getByTitle('app.discoverUnavailableList').textContent).toBe('!');
        window.api.getMemberChallenges.mockResolvedValue({ success: true, items });
        fireEvent.click(screen.getByText('app.discoverRefresh'));
        await screen.findByText('Free One');
        expect(window.api.getMemberChallenges).toHaveBeenCalledTimes(2);
    });

    test('rows fall back from title to url to an untitled label', async () => {
        window.api.getMemberChallenges = jest.fn().mockResolvedValue({
            success: true,
            items: [
                { id: 1, url: 'just-url' },
                { id: 2, join_coins: 'x' },
            ],
        });
        renderSection();
        expect(await screen.findByText('just-url')).toBeTruthy();
        expect(screen.getByText('app.discoverUntitled')).toBeTruthy();
        // A non-numeric cost is treated as free.
        expect(screen.getAllByText('app.discoverCostFree')).toHaveLength(2);
    });

    test('a successful join refetches and notifies the parent', async () => {
        const { onJoined } = renderSection();
        await screen.findByText('Free One');
        fireEvent.click(screen.getByText('app.discoverJoin'));
        await screen.findByText('app.discoverJoined');
        expect(onJoined).toHaveBeenCalledTimes(1);
        expect(window.api.getMemberChallenges).toHaveBeenCalledTimes(2);
        expect(screen.getByText('app.discoverJoined').className).toContain('text-success');
    });

    test('an unavailable challenge refetches without touching balances', async () => {
        window.api.joinChallenge = jest.fn().mockResolvedValue({ success: false, status: 'unavailable' });
        const { onJoined } = renderSection();
        await screen.findByText('Free One');
        fireEvent.click(screen.getByText('app.discoverJoin'));
        await screen.findByText('app.discoverUnavailable');
        await waitFor(() => expect(window.api.getMemberChallenges).toHaveBeenCalledTimes(2));
        expect(onJoined).not.toHaveBeenCalled();
    });

    test('a thrown join is reported as failed-no-charge; a statusless failure without text is generic', async () => {
        window.api.joinChallenge = jest.fn().mockRejectedValue(new Error('ipc gone'));
        renderSection();
        await screen.findByText('Free One');
        fireEvent.click(screen.getByText('app.discoverJoin'));
        expect(await screen.findByText('app.discoverFailedNoCharge')).toBeTruthy();
        expect(screen.getByText('app.discoverJoin').disabled).toBe(false);

        window.api.joinChallenge = jest.fn().mockResolvedValue({ success: false });
        fireEvent.click(screen.getByText('app.discoverJoin'));
        expect(await screen.findByText('app.discoverGenericError')).toBeTruthy();
    });

    test('the join button reads Joining while in flight', async () => {
        let resolve;
        window.api.joinChallenge = jest.fn(() => new Promise((r) => (resolve = r)));
        renderSection();
        await screen.findByText('Free One');
        fireEvent.click(screen.getByText('app.discoverJoin'));
        const joining = await screen.findByText('app.discoverJoining');
        expect(joining.disabled).toBe(true);
        resolve({ success: true, status: 'joined' });
        await screen.findByText('app.discoverJoined');
    });

    test('retry submit re-joins the charged challenge with spendCoins=true', async () => {
        window.api.joinChallenge = jest.fn().mockResolvedValue({ status: 'charged-pending-submit', cost: 100 });
        const { onJoined } = renderSection();
        await screen.findByText('Paid One');
        fireEvent.click(screen.getByText('app.discoverJoinPaid'));
        fireEvent.click(await screen.findByText('app.discoverConfirmSpend'));
        await screen.findByText('app.discoverRetrySubmit');
        window.api.joinChallenge.mockResolvedValue({ success: true, status: 'joined' });
        fireEvent.click(screen.getByText('app.discoverRetrySubmit'));
        await screen.findByText('app.discoverJoined');
        expect(window.api.joinChallenge).toHaveBeenLastCalledWith(900002, true);
        expect(onJoined).toHaveBeenCalledTimes(2);
    });

    test('Cancel and the close button dismiss the confirm modal without spending', async () => {
        renderSection();
        await screen.findByText('Paid One');
        fireEvent.click(screen.getByText('app.discoverJoinPaid'));
        fireEvent.click(await screen.findByText('app.cancel'));
        await waitFor(() => expect(screen.queryByText('app.discoverConfirmTitle')).toBeNull());

        fireEvent.click(screen.getByText('app.discoverJoinPaid'));
        await screen.findByText('app.discoverConfirmTitle');
        fireEvent.click(document.querySelector('[role="dialog"] button[aria-label]'));
        await waitFor(() => expect(screen.queryByText('app.discoverConfirmTitle')).toBeNull());
        expect(window.api.joinChallenge).not.toHaveBeenCalled();
    });

    test('an unknown balance says so and still allows the spend; a url-only paid challenge is named by url', async () => {
        window.api.getMemberChallenges = jest
            .fn()
            .mockResolvedValue({ success: true, items: [{ id: 5, url: 'paid-url', join_coins: 10 }] });
        mockTranslator.t.mockImplementation((key) =>
            key === 'app.discoverConfirmBody' ? 'join {title} for {coins}' : key,
        );
        try {
            renderSection({ bankroll: null });
            await screen.findByText('paid-url');
            fireEvent.click(screen.getByText('app.discoverJoinPaid'));
            expect(await screen.findByText('app.discoverConfirmBalanceUnknown')).toBeTruthy();
            expect(screen.getByText('join paid-url for 10')).toBeTruthy();
            expect(screen.getByText('app.discoverConfirmSpend').disabled).toBe(false);
        } finally {
            mockTranslator.t.mockImplementation((key) => key);
        }
    });

    test('an affordable paid join shows the resulting balance', async () => {
        renderSection();
        await screen.findByText('Paid One');
        fireEvent.click(screen.getByText('app.discoverJoinPaid'));
        expect(await screen.findByText('app.discoverConfirmBalance')).toBeTruthy();
    });
});
