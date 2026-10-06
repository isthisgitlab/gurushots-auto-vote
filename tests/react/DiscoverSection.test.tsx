/**
 * Component tests for DiscoverSection: free joins call joinChallenge directly;
 * paid joins go through the confirm modal and only spend on confirm. The
 * translation manager returns keys verbatim in tests, so buttons are matched by
 * their i18n key text.
 */

import { render, screen, fireEvent, waitFor } from './helpers/test-utils';
import { DiscoverSection } from '@/components/app/DiscoverSection';
import { mockTranslator } from './helpers/setup';
import { invalid } from '../helpers/invalid';
import type { OpenChallenge } from '../../src/ts/types/gurushots';
import type { WindowApi } from '../../src/ts/types/ipc';

const items = invalid<OpenChallenge[]>([
    { id: 900001, type: 'default', join_coins: 0, title: 'Free One', chosenOwn: [], chosenEffectiveCount: 0 },
    { id: 900002, type: 'flash', join_coins: 100, title: 'Paid One', chosenOwn: [], chosenEffectiveCount: 0 },
]);

beforeEach(() => {
    window.api = invalid({
        onSettingsChanged: undefined,
        getMemberChallenges: jest.fn().mockResolvedValue({ success: true, items }),
        joinChallenge: jest.fn().mockResolvedValue({ success: true, status: 'joined' }),
    });
});

test('renders collapsed by default with an open-count badge', async () => {
    const { container } = render(
        <DiscoverSection isLoggedIn bankroll={invalid({ coins: 500 })} onJoined={jest.fn()} />,
    );
    await screen.findByText('Free One');
    const details = container.querySelector('[data-testid="discover-section"]')!;
    // Compact + out of the way: a <details> that starts closed.
    expect(details.tagName.toLowerCase()).toBe('details');
    expect(details.hasAttribute('open')).toBe(false);
    // Summary shows the open-challenge count (2 fixtures).
    expect(screen.getByText('2')).toBeTruthy();
});

test('the count badge is hidden when there are no open challenges', async () => {
    window.api.getMemberChallenges = jest.fn().mockResolvedValue({ success: true, items: [] });
    render(<DiscoverSection isLoggedIn bankroll={invalid({ coins: 500 })} onJoined={jest.fn()} />);
    await screen.findByText('app.discoverEmpty');
    expect(screen.queryByText('0')).toBeNull();
});

test('free join calls joinChallenge with spendCoins=false, no modal', async () => {
    render(<DiscoverSection isLoggedIn bankroll={invalid({ coins: 500 })} onJoined={jest.fn()} />);
    await screen.findByText('Free One');
    const joinBtn = screen.getByText('app.discoverJoin');
    fireEvent.click(joinBtn);
    await waitFor(() => expect(window.api.joinChallenge).toHaveBeenCalledWith(900001, false));
    // No confirm modal for the free path.
    expect(screen.queryByText('app.discoverConfirmTitle')).toBeNull();
});

test('paid join opens the confirm modal and only spends on confirm', async () => {
    render(<DiscoverSection isLoggedIn bankroll={invalid({ coins: 500 })} onJoined={jest.fn()} />);
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
    render(<DiscoverSection isLoggedIn bankroll={invalid({ coins: 500 })} onJoined={jest.fn()} />);
    await screen.findByText('Free One');
    fireEvent.click(screen.getByText('app.discoverJoin'));
    // No mapped status → falls back to the result's error text, never silent.
    await screen.findByText('No authentication token found');
});

test('confirm modal blocks the spend when the balance is short', async () => {
    render(<DiscoverSection isLoggedIn bankroll={invalid({ coins: 50 })} onJoined={jest.fn()} />);
    await screen.findByText('Paid One');
    fireEvent.click(screen.getByText('app.discoverJoinPaid'));
    await screen.findByText('app.discoverConfirmTitle');
    // Insufficient message shown and the Spend button disabled.
    await screen.findByText('app.discoverConfirmInsufficient');
    const spendBtn = screen.getByText<HTMLButtonElement>('app.discoverConfirmSpend');
    expect(spendBtn.disabled).toBe(true);
    expect(window.api.joinChallenge).not.toHaveBeenCalled();
});

test('charged-pending-submit shows the distinct message + retry action', async () => {
    window.api.joinChallenge = jest.fn().mockResolvedValue({ status: 'charged-pending-submit', cost: 100 });
    render(<DiscoverSection isLoggedIn bankroll={invalid({ coins: 500 })} onJoined={jest.fn()} />);
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
        render(<DiscoverSection isLoggedIn bankroll={invalid({ coins: 500 })} onJoined={onJoined} {...props} />);
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
        jest.mocked(window.api.getMemberChallenges).mockResolvedValue({ success: true, items });
        fireEvent.click(screen.getByText('app.discoverRefresh'));
        await screen.findByText('Free One');
        expect(window.api.getMemberChallenges).toHaveBeenCalledTimes(2);
    });

    test('rows fall back from title to url to an untitled label', async () => {
        window.api.getMemberChallenges = jest.fn().mockResolvedValue({
            success: true,
            items: [
                { id: 1, url: 'just-url', chosenOwn: [], chosenEffectiveCount: 0 },
                { id: 2, join_coins: 'x', chosenOwn: [], chosenEffectiveCount: 0 },
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
        expect(screen.getByText<HTMLButtonElement>('app.discoverJoin').disabled).toBe(false);

        window.api.joinChallenge = jest.fn().mockResolvedValue({ success: false });
        fireEvent.click(screen.getByText('app.discoverJoin'));
        expect(await screen.findByText('app.discoverGenericError')).toBeTruthy();
    });

    test('an invalid-args failure shows the translated message, not the code', async () => {
        window.api.joinChallenge = jest.fn().mockResolvedValue({ success: false, error: 'invalid-args' });
        renderSection();
        await screen.findByText('Free One');
        fireEvent.click(screen.getByText('app.discoverJoin'));
        expect(await screen.findByText('errors.actionInvalidArgs')).toBeTruthy();
        expect(screen.queryByText('invalid-args')).toBeNull();
    });

    test('the join button reads Joining while in flight', async () => {
        let resolve: ((value: Awaited<ReturnType<WindowApi['joinChallenge']>>) => void) | undefined;
        window.api.joinChallenge = jest.fn(() => new Promise((r) => (resolve = r)));
        renderSection();
        await screen.findByText('Free One');
        fireEvent.click(screen.getByText('app.discoverJoin'));
        const joining = await screen.findByText<HTMLButtonElement>('app.discoverJoining');
        expect(joining.disabled).toBe(true);
        resolve!(invalid({ success: true, status: 'joined' }));
        await screen.findByText('app.discoverJoined');
    });

    test('retry submit re-joins the charged challenge with spendCoins=true', async () => {
        window.api.joinChallenge = jest.fn().mockResolvedValue({ status: 'charged-pending-submit', cost: 100 });
        const { onJoined } = renderSection();
        await screen.findByText('Paid One');
        fireEvent.click(screen.getByText('app.discoverJoinPaid'));
        fireEvent.click(await screen.findByText('app.discoverConfirmSpend'));
        await screen.findByText('app.discoverRetrySubmit');
        jest.mocked(window.api.joinChallenge).mockResolvedValue(invalid({ success: true, status: 'joined' }));
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
        fireEvent.click(document.querySelector('[role="dialog"] button[aria-label]')!);
        await waitFor(() => expect(screen.queryByText('app.discoverConfirmTitle')).toBeNull());
        expect(window.api.joinChallenge).not.toHaveBeenCalled();
    });

    test('an unknown balance says so and still allows the spend; a url-only paid challenge is named by url', async () => {
        window.api.getMemberChallenges = jest
            .fn()
            .mockResolvedValue({
                success: true,
                items: [{ id: 5, url: 'paid-url', join_coins: 10, chosenOwn: [], chosenEffectiveCount: 0 }],
            });
        mockTranslator.t.mockImplementation((key) =>
            key === 'app.discoverConfirmBody' ? 'join {title} for {coins}' : key,
        );
        try {
            renderSection({ bankroll: null });
            await screen.findByText('paid-url');
            fireEvent.click(screen.getByText('app.discoverJoinPaid'));
            expect(await screen.findByText('app.discoverConfirmBalanceUnknown')).toBeTruthy();
            expect(screen.getByText('join paid-url for 10')).toBeTruthy();
            expect(screen.getByText<HTMLButtonElement>('app.discoverConfirmSpend').disabled).toBe(false);
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

describe('chosen photos', () => {
    const PHOTO = `00000001${'a'.repeat(24)}`;
    // Challenge id -> the list saved for that challenge alone.
    let own: Record<string, string[]>;
    let globalList: string[];

    // What the main process annotates each open challenge with: its own list, and how many photos
    // apply once the layers are resolved (an own list, even an empty one, wins over the global one).
    const annotated = () =>
        items.map((c) => {
            const mine = own[String(c.id)];
            return { ...c, chosenOwn: mine ?? [], chosenEffectiveCount: (mine ?? globalList).length };
        });

    beforeEach(() => {
        own = {};
        globalList = [];
        window.api = invalid({
            onSettingsChanged: undefined,
            getSetting: jest.fn().mockResolvedValue(''),
            getMemberChallenges: jest.fn(async () => ({ success: true, items: annotated() })),
            joinChallenge: jest.fn().mockResolvedValue({ success: true, status: 'joined' }),
            setChallengeOverride: jest.fn(async (_key: string, id: string, value: string[]) => {
                own[id] = value;
                return true;
            }),
            removeChallengeOverride: jest.fn(async (_key: string, id: string) => {
                delete own[id];
                return true;
            }),
            getLibraryPhotos: jest.fn().mockResolvedValue({
                success: true,
                photos: [{ id: PHOTO, labels: ['sea'], allowed: true, message: null, uploadDate: 1 }],
                memberId: 'c'.repeat(32),
                truncated: false,
                allowedKnown: true,
            }),
        });
    });

    const renderSection = () =>
        render(<DiscoverSection isLoggedIn bankroll={invalid({ coins: 500 })} onJoined={jest.fn()} />);

    test('a row with no list of its own has no Chosen chip, only the Choose photos action', async () => {
        renderSection();
        await screen.findByText('Free One');
        expect(screen.queryByText('app.discoverChosenChip')).toBeNull();
        expect(screen.getAllByText('app.choosePhotos')).toHaveLength(2);
    });

    test('Choose photos opens the chooser for that challenge and saves its own list', async () => {
        renderSection();
        await screen.findByText('Free One');
        fireEvent.click(screen.getAllByText('app.choosePhotos')[0]);
        await waitFor(() => expect(window.api.getLibraryPhotos).toHaveBeenCalledWith(900001, undefined));
        fireEvent.click(await screen.findByRole('button', { name: 'app.photoChooserTileLabel' }));
        fireEvent.click(screen.getByRole('button', { name: 'app.photoChooserUse' }));
        await waitFor(() =>
            expect(window.api.setChallengeOverride).toHaveBeenCalledWith('chosenPhotos', '900001', [PHOTO]),
        );
        // The list is read again after the save: the row now carries the chip, the other row does not.
        expect(await screen.findByText('app.discoverChosenChip')).toBeTruthy();
        expect(screen.getAllByText('app.discoverChosenChip')).toHaveLength(1);
        expect(window.api.getMemberChallenges).toHaveBeenCalledTimes(2);
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    });

    test('the Chosen chip reopens the chooser on the saved list; saving none removes the list', async () => {
        own['900001'] = [PHOTO];
        renderSection();
        fireEvent.click(await screen.findByText('app.discoverChosenChip'));
        const tile = await screen.findByRole('button', { name: 'app.photoChooserTileLabel' });
        expect(tile.getAttribute('aria-pressed')).toBe('true');
        fireEvent.click(tile);
        fireEvent.click(screen.getByRole('button', { name: 'app.photoChooserUse' }));
        await waitFor(() => expect(window.api.removeChallengeOverride).toHaveBeenCalledWith('chosenPhotos', '900001'));
        await waitFor(() => expect(screen.queryByText('app.discoverChosenChip')).toBeNull());
    });

    test('the Choose photos button and the Chosen chip are named by their challenge', async () => {
        own['900001'] = [PHOTO];
        mockTranslator.t.mockImplementation((key) =>
            key === 'app.discoverChoosePhotosLabel'
                ? 'Choose photos for {title}'
                : key === 'app.discoverChosenChipLabel'
                  ? 'Chosen photos for {title}'
                  : key,
        );
        try {
            renderSection();
            await screen.findByText('Free One');
            expect(screen.getByRole('button', { name: 'Choose photos for Free One' })).toBeTruthy();
            expect(screen.getByRole('button', { name: 'Choose photos for Paid One' })).toBeTruthy();
            expect(screen.getByRole('button', { name: 'Chosen photos for Free One' })).toBeTruthy();
            expect(screen.queryByRole('button', { name: 'Chosen photos for Paid One' })).toBeNull();
        } finally {
            mockTranslator.t.mockImplementation((key) => key);
        }
    });

    test('a refused save keeps the chooser open on its error and leaves the row alone', async () => {
        jest.mocked(window.api.setChallengeOverride).mockResolvedValue(false);
        renderSection();
        await screen.findByText('Free One');
        fireEvent.click(screen.getAllByText('app.choosePhotos')[0]);
        fireEvent.click(await screen.findByRole('button', { name: 'app.photoChooserTileLabel' }));
        fireEvent.click(screen.getByRole('button', { name: 'app.photoChooserUse' }));
        expect((await screen.findByRole('alert')).textContent).toContain('app.photoChooserSaveError');
        expect(screen.queryByText('app.discoverChosenChip')).toBeNull();
    });

    test('a save the bridge rejects counts as refused', async () => {
        jest.mocked(window.api.setChallengeOverride).mockRejectedValue(new Error('down'));
        renderSection();
        await screen.findByText('Free One');
        fireEvent.click(screen.getAllByText('app.choosePhotos')[0]);
        fireEvent.click(await screen.findByRole('button', { name: 'app.photoChooserTileLabel' }));
        fireEvent.click(screen.getByRole('button', { name: 'app.photoChooserUse' }));
        expect((await screen.findByRole('alert')).textContent).toContain('app.photoChooserSaveError');
    });

    test('the paid-join confirm names the chosen photo only when a list applies to that row', async () => {
        renderSection();
        await screen.findByText('Paid One');
        fireEvent.click(screen.getByText('app.discoverJoinPaid'));
        await screen.findByText('app.discoverConfirmTitle');
        expect(screen.queryByText('app.discoverConfirmChosen')).toBeNull();
        fireEvent.click(screen.getByText('app.cancel'));
        await waitFor(() => expect(screen.queryByText('app.discoverConfirmTitle')).toBeNull());
    });

    test('a list from the global settings applies to the row too, shown as inherited', async () => {
        globalList = [PHOTO, 'other'];
        renderSection();
        await screen.findByText('Paid One');
        // Only a list of the row's own gets the chip; the row says what it inherits instead.
        expect(screen.queryByText('app.discoverChosenChip')).toBeNull();
        expect(screen.getAllByText('app.discoverChosenInherited')).toHaveLength(2);
        fireEvent.click(screen.getByText('app.discoverJoinPaid'));
        expect(await screen.findByText('app.discoverConfirmChosen')).toBeTruthy();
    });

    test('a row with a list of its own shows the chip, not the inherited line', async () => {
        globalList = [PHOTO];
        own['900001'] = [PHOTO];
        renderSection();
        await screen.findByText('app.discoverChosenChip');
        // Only the other row inherits.
        expect(screen.getAllByText('app.discoverChosenInherited')).toHaveLength(1);
    });

    test('in a row that inherits, the chooser says that saving nothing makes it inherit again', async () => {
        globalList = [PHOTO];
        renderSection();
        await screen.findByText('Free One');
        fireEvent.click(screen.getAllByText('app.choosePhotos')[0]);
        expect(await screen.findByText('app.photoChooserInheritNote')).toBeTruthy();
    });

    test('a row whose own list is empty reads as having none', async () => {
        own['900002'] = [];
        renderSection();
        await screen.findByText('Paid One');
        expect(screen.queryByText('app.discoverChosenChip')).toBeNull();
        expect(screen.queryByText('app.discoverChosenInherited')).toBeNull();
    });
});
