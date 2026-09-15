/**
 * Component tests for DiscoverSection: free joins call joinChallenge directly;
 * paid joins go through the confirm modal and only spend on confirm. The
 * translation manager returns keys verbatim in tests, so buttons are matched by
 * their i18n key text.
 */

import { render, screen, fireEvent, waitFor } from './helpers/test-utils';
import { DiscoverSection } from '@/components/app/DiscoverSection';

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
