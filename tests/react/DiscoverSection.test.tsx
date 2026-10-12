/**
 * Component tests for DiscoverSection: free joins call joinChallenge directly;
 * paid joins go through the confirm modal and only spend on confirm. The
 * translation manager returns keys verbatim in tests, so buttons are matched by
 * their i18n key text.
 */

import { act, render, screen, fireEvent, waitFor, within } from './helpers/test-utils';
import { DiscoverSection } from '@/components/app/DiscoverSection';
import { fireSettingsChanged, mockApi, mockTranslator } from './helpers/setup';
import { invalid } from '../helpers/invalid';
import { app } from '../../src/ts/translations/english';
import type { OpenChallenge } from '../../src/ts/types/gurushots';
import type { WindowApi } from '../../src/ts/types/ipc';
import type { JoinOutcome } from '@/components/app/DiscoverSection';

type JoinApi = WindowApi['joinChallenge'];
type ListApi = WindowApi['getMemberChallenges'];
// Typed mocks of the two calls this file drives; what they answer is a partial fixture, so it goes through invalid().
const joinMock = () => jest.fn<ReturnType<JoinApi>, Parameters<JoinApi>>();
const listMock = () => jest.fn<ReturnType<ListApi>, Parameters<ListApi>>();

const items = invalid<OpenChallenge[]>([
    {
        id: 900001,
        type: 'default',
        join_coins: 0,
        title: 'Free One',
        chosenOwn: [],
        chosenOwnCount: 0,
        chosenEffectiveCount: 0,
    },
    {
        id: 900002,
        type: 'flash',
        join_coins: 100,
        title: 'Paid One',
        chosenOwn: [],
        chosenOwnCount: 0,
        chosenEffectiveCount: 0,
    },
]);

beforeEach(() => {
    window.api = invalid({
        onSettingsChanged: undefined,
        getMemberChallenges: listMock().mockResolvedValue(invalid({ success: true, items })),
        // A paid row first asks without spending, and the server answers with its cost; a free row joins.
        joinChallenge: joinMock().mockImplementation(async (id, spendCoins) =>
            invalid(
                id === 900002 && spendCoins === false
                    ? { success: false, status: 'needs-confirm', cost: 100 }
                    : { success: true, status: 'joined' },
            ),
        ),
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

test('the count badge is an image named with its count, not a bare number', async () => {
    mockTranslator.t.mockImplementation((key) => (key === 'app.discoverCountLabel' ? '{count} open challenges' : key));
    try {
        render(<DiscoverSection isLoggedIn bankroll={invalid({ coins: 500 })} onJoined={jest.fn()} />);
        await screen.findByText('Free One');
        const badge = screen.getByRole('img', { name: '2 open challenges' });
        expect(badge.textContent).toBe('2');
    } finally {
        mockTranslator.t.mockImplementation((key) => key);
    }
});

test('the count badge is hidden when there are no open challenges', async () => {
    window.api.getMemberChallenges = listMock().mockResolvedValue(invalid({ success: true, items: [] }));
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

    // Modal appears once the server has named the cost; nothing is charged, and nothing was asked to be.
    await screen.findByText('app.discoverConfirmTitle');
    expect(window.api.joinChallenge).toHaveBeenCalledTimes(1);
    expect(window.api.joinChallenge).toHaveBeenCalledWith(900002, false);

    // Confirm → spends with spendCoins=true, naming the cost the modal showed (100): a price that rose since
    // then is not consented to.
    fireEvent.click(screen.getByText('app.discoverConfirmSpend'));
    await waitFor(() => expect(window.api.joinChallenge).toHaveBeenCalledWith(900002, true, 100));
});

// What the server answers a join that has to be confirmed first: its cost, and nothing is spent.
const priceAsk = (cost?: unknown) => ({
    success: false,
    status: 'needs-confirm',
    ...(cost === undefined ? {} : { cost }),
});

// A paid row's join: the ask answers with its cost, and the confirmed join answers `final`.
const spendLater = (final: unknown, askedCost = 100) =>
    joinMock().mockImplementation(async (_id, spendCoins) => invalid(spendCoins ? final : priceAsk(askedCost)));

test('a price that rose after it was shown spends nothing: the row says so, and the list is read again', async () => {
    // The ask names 100; by the time it is confirmed the price is 150.
    window.api.joinChallenge = joinMock().mockImplementation(async (_id, spendCoins) =>
        invalid(priceAsk(spendCoins ? 150 : 100)),
    );
    mockTranslator.t.mockImplementation((key) => (key === 'app.discoverPriceChanged' ? 'Now {coins} coins' : key));
    try {
        render(<DiscoverSection isLoggedIn bankroll={invalid({ coins: 500 })} onJoined={jest.fn()} />);
        await screen.findByText('Paid One');
        const reads = jest.mocked(window.api.getMemberChallenges).mock.calls.length;
        fireEvent.click(screen.getByText('app.discoverJoinPaid'));
        fireEvent.click(await screen.findByText('app.discoverConfirmSpend'));
        expect(await screen.findByText('Now 150 coins')).toBeTruthy();
        expect(window.api.joinChallenge).toHaveBeenLastCalledWith(900002, true, 100);
        await waitFor(() => expect(jest.mocked(window.api.getMemberChallenges).mock.calls.length).toBe(reads + 1));
    } finally {
        mockTranslator.t.mockImplementation((key) => key);
    }
});

describe('what a join answered is announced', () => {
    const answerWith = async (res: Record<string, unknown>) => {
        window.api.joinChallenge = joinMock().mockResolvedValue(invalid(res));
        render(<DiscoverSection isLoggedIn bankroll={invalid({ coins: 500 })} onJoined={jest.fn()} />);
        await screen.findByText('Free One');
        fireEvent.click(screen.getByText('app.discoverJoin'));
    };

    test.each([
        ['a join that worked', { success: true, status: 'joined' }, 'app.discoverJoined', 'status'],
        ['a challenge that is gone', { success: false, status: 'unavailable' }, 'app.discoverUnavailable', 'status'],
        ['a join already running', { success: false, status: 'busy' }, 'app.discoverBusy', 'status'],
        [
            'a balance too low',
            { success: false, status: 'skipped-unaffordable', cost: 9, coins: 1 },
            'app.discoverUnaffordable',
            'alert',
        ],
        ['a refused join', { success: false, status: 'failed-no-charge' }, 'app.discoverFailedNoCharge', 'alert'],
        [
            'an unmapped failure',
            { success: false, error: 'No authentication token found' },
            'No authentication token found',
            'alert',
        ],
    ])('%s is announced as a %s', async (_name, res, text, role) => {
        await answerWith(res);
        const line = await screen.findByText(text);
        expect(line.getAttribute('role')).toBe(role);
        expect(within(screen.getByRole(role as 'status' | 'alert')).getByText(text)).toBeTruthy();
    });
});

describe('a price that rose', () => {
    const confirmTexts = (key: string) =>
        key === 'app.discoverConfirmBody'
            ? 'Costs {coins}'
            : key === 'app.discoverConfirmSpend'
              ? 'Spend {coins}'
              : key;

    test('the next confirmation, before the list is read again, shows and names the new cost', async () => {
        // The first read stays the only one that answers: the refetch after the price change never comes back.
        window.api.getMemberChallenges = listMock()
            .mockResolvedValueOnce(invalid({ success: true, items }))
            .mockReturnValue(invalid(new Promise(() => undefined)));
        let asked = 0;
        window.api.joinChallenge = joinMock().mockImplementation(async (_id, spendCoins) =>
            // Asked at 100, confirmed at 100 but now 150 (so repriced), asked again: 150.
            invalid(spendCoins ? priceAsk(150) : priceAsk(asked++ === 0 ? 100 : 150)),
        );
        mockTranslator.t.mockImplementation(confirmTexts);
        try {
            render(<DiscoverSection isLoggedIn bankroll={invalid({ coins: 500 })} onJoined={jest.fn()} />);
            await screen.findByText('Paid One');
            fireEvent.click(screen.getByText('app.discoverJoinPaid'));
            fireEvent.click(await screen.findByText('Spend 100'));
            await waitFor(() => expect(window.api.joinChallenge).toHaveBeenCalledWith(900002, true, 100));

            // Press Join again while the list has not been read again: it is 150 now, not 100.
            fireEvent.click(screen.getByText('app.discoverJoinPaid'));
            expect(await screen.findByText('Costs 150')).toBeTruthy();
            fireEvent.click(screen.getByText('Spend 150'));
            await waitFor(() => expect(window.api.joinChallenge).toHaveBeenLastCalledWith(900002, true, 150));
        } finally {
            mockTranslator.t.mockImplementation((key) => key);
        }
    });

    test('once the list is read again, the row goes by what the list says', async () => {
        window.api.getMemberChallenges = listMock()
            .mockResolvedValueOnce(invalid({ success: true, items }))
            .mockResolvedValue(
                invalid({
                    success: true,
                    items: invalid<OpenChallenge[]>([items[0], { ...items[1], join_coins: 120 }]),
                }),
            );
        let asked = 0;
        window.api.joinChallenge = joinMock().mockImplementation(async (_id, spendCoins) =>
            invalid(spendCoins ? priceAsk(150) : priceAsk(asked++ === 0 ? 100 : 120)),
        );
        mockTranslator.t.mockImplementation(confirmTexts);
        try {
            render(<DiscoverSection isLoggedIn bankroll={invalid({ coins: 500 })} onJoined={jest.fn()} />);
            await screen.findByText('Paid One');
            fireEvent.click(screen.getByText('app.discoverJoinPaid'));
            fireEvent.click(await screen.findByText('Spend 100'));
            await waitFor(() => expect(window.api.getMemberChallenges).toHaveBeenCalledTimes(2));
            fireEvent.click(await screen.findByText('app.discoverJoinPaid'));
            // The list was read again and says 120: that is what is shown and named.
            expect(await screen.findByText('Spend 120')).toBeTruthy();
        } finally {
            mockTranslator.t.mockImplementation((key) => key);
        }
    });
});

test.each([
    ['no cost', invalid<JoinOutcome>(priceAsk())],
    ['a null cost', invalid<JoinOutcome>(priceAsk(null))],
    ['a cost that is no number', invalid<JoinOutcome>(priceAsk('150'))],
])(
    'an ask with %s keeps the listed price: the row does not turn free, and the confirmation names it',
    async (_name, answer) => {
        window.api.getMemberChallenges = listMock()
            .mockResolvedValueOnce(invalid({ success: true, items }))
            .mockReturnValue(invalid(new Promise(() => undefined)));
        window.api.joinChallenge = joinMock()
            .mockResolvedValueOnce(invalid(answer))
            .mockResolvedValue(invalid({ success: true, status: 'joined' }));
        mockTranslator.t.mockImplementation((key) => (key === 'app.discoverConfirmSpend' ? 'Spend {coins}' : key));
        try {
            render(<DiscoverSection isLoggedIn bankroll={invalid({ coins: 500 })} onJoined={jest.fn()} />);
            await screen.findByText('Paid One');
            fireEvent.click(screen.getByText('app.discoverJoinPaid'));
            // A cost of 0 (what Number(null) would read) must not make the row look free or the modal price 0.
            fireEvent.click(await screen.findByText('Spend 100'));
            await waitFor(() => expect(window.api.joinChallenge).toHaveBeenLastCalledWith(900002, true, 100));
            expect(screen.getAllByText('app.discoverJoinPaid')).toHaveLength(1);
        } finally {
            mockTranslator.t.mockImplementation((key) => key);
        }
    },
);

describe('a paid row that was already charged', () => {
    test('Join does not ask to spend again: the server submits, and the outcome is shown', async () => {
        // An unlock marker is left: the server retries the submit alone and answers joined.
        window.api.joinChallenge = joinMock().mockResolvedValue(invalid({ success: true, status: 'joined' }));
        const onJoined = jest.fn();
        render(<DiscoverSection isLoggedIn bankroll={invalid({ coins: 5 })} onJoined={onJoined} />);
        await screen.findByText('Paid One');
        fireEvent.click(screen.getByText('app.discoverJoinPaid'));
        expect(await screen.findByText('app.discoverJoined')).toBeTruthy();
        expect(screen.queryByText('app.discoverConfirmTitle')).toBeNull();
        expect(window.api.joinChallenge).toHaveBeenCalledTimes(1);
        expect(window.api.joinChallenge).toHaveBeenCalledWith(900002, false);
        expect(onJoined).toHaveBeenCalled();
    });

    test('with a balance too low to pay again it still finishes: no modal that disables the button', async () => {
        window.api.joinChallenge = joinMock().mockResolvedValue(invalid({ success: true, status: 'joined' }));
        render(<DiscoverSection isLoggedIn bankroll={invalid({ coins: 0 })} onJoined={jest.fn()} />);
        await screen.findByText('Paid One');
        fireEvent.click(screen.getByText('app.discoverJoinPaid'));
        await screen.findByText('app.discoverJoined');
        expect(screen.queryByText('app.discoverConfirmInsufficient')).toBeNull();
    });

    test('a paid row not charged yet opens the confirmation at the cost the server named', async () => {
        window.api.joinChallenge = joinMock().mockImplementation(async (_id, spendCoins) =>
            invalid(spendCoins ? { success: true, status: 'joined' } : priceAsk(120)),
        );
        mockTranslator.t.mockImplementation((key) =>
            key === 'app.discoverConfirmBody'
                ? 'Costs {coins}'
                : key === 'app.discoverConfirmSpend'
                  ? 'Spend {coins}'
                  : key,
        );
        try {
            render(<DiscoverSection isLoggedIn bankroll={invalid({ coins: 500 })} onJoined={jest.fn()} />);
            await screen.findByText('Paid One');
            fireEvent.click(screen.getByText('app.discoverJoinPaid'));
            expect(await screen.findByText('Costs 120')).toBeTruthy();
            expect(window.api.joinChallenge).toHaveBeenCalledTimes(1);
            fireEvent.click(screen.getByText('Spend 120'));
            await waitFor(() => expect(window.api.joinChallenge).toHaveBeenLastCalledWith(900002, true, 120));
        } finally {
            mockTranslator.t.mockImplementation((key) => key);
        }
    });

    test('while a paid row is only being asked what it costs the button says "Checking…", not "Joining…"; a free row says "Joining…"', async () => {
        const pending = new Promise<never>(() => undefined);
        window.api.joinChallenge = joinMock().mockReturnValue(invalid(pending));
        render(<DiscoverSection isLoggedIn bankroll={invalid({ coins: 500 })} onJoined={jest.fn()} />);
        await screen.findByText('Paid One');
        fireEvent.click(screen.getByText('app.discoverJoinPaid'));
        expect(await screen.findByText('app.discoverChecking')).toBeTruthy();
        expect(screen.queryByText('app.discoverJoining')).toBeNull();
        fireEvent.click(screen.getByText('app.discoverJoin'));
        expect(await screen.findByText('app.discoverJoining')).toBeTruthy();
    });

    test('a real, confirmed join says "Joining…"', async () => {
        let release!: () => void;
        window.api.joinChallenge = joinMock().mockImplementation(async (_id, spendCoins) => {
            if (!spendCoins) return invalid(priceAsk(100));
            await new Promise<void>((resolve) => (release = resolve));
            return invalid({ success: true, status: 'joined' });
        });
        render(<DiscoverSection isLoggedIn bankroll={invalid({ coins: 500 })} onJoined={jest.fn()} />);
        await screen.findByText('Paid One');
        fireEvent.click(screen.getByText('app.discoverJoinPaid'));
        fireEvent.click(await screen.findByText('app.discoverConfirmSpend'));
        expect(await screen.findByText('app.discoverJoining')).toBeTruthy();
        expect(screen.queryByText('app.discoverChecking')).toBeNull();
        await act(async () => release());
    });

    describe('two paid rows asked at once', () => {
        const paid = (id: number, title: string, join_coins: number) => ({ ...items[1], id, title, join_coins });
        const twoPaid = invalid<OpenChallenge[]>([paid(11, 'Alpha', 100), paid(12, 'Beta', 200)]);

        test('an answer that comes while a dialog is open does not swap what it asks to pay for, and its row is left alone', async () => {
            window.api.getMemberChallenges = listMock().mockResolvedValue(invalid({ success: true, items: twoPaid }));
            const release: Record<number, () => void> = {};
            window.api.joinChallenge = joinMock().mockImplementation((id, spendCoins) =>
                spendCoins
                    ? Promise.resolve(invalid({ success: true, status: 'joined' }))
                    : new Promise((resolve) => {
                          release[Number(id)] = () => resolve(invalid(priceAsk(id === 11 ? 100 : 200)));
                      }),
            );
            mockTranslator.t.mockImplementation((key) =>
                key === 'app.discoverConfirmBody'
                    ? 'Join {title} for {coins}'
                    : key === 'app.discoverConfirmSpend'
                      ? 'Spend {coins}'
                      : key,
            );
            try {
                render(<DiscoverSection isLoggedIn bankroll={invalid({ coins: 500 })} onJoined={jest.fn()} />);
                await screen.findByText('Alpha');
                const [first, second] = screen.getAllByText('app.discoverJoinPaid');
                fireEvent.click(first);
                fireEvent.click(second);
                await waitFor(() => expect(Object.keys(release)).toHaveLength(2));
                await act(async () => release[11]());
                expect(await screen.findByText('Join Alpha for 100')).toBeTruthy();
                // Beta's answer arrives with Alpha's dialog open.
                await act(async () => release[12]());
                expect(screen.getByText('Join Alpha for 100')).toBeTruthy();
                expect(screen.queryByText('Join Beta for 200')).toBeNull();
                fireEvent.click(screen.getByText('Spend 100'));
                await waitFor(() => expect(window.api.joinChallenge).toHaveBeenLastCalledWith(11, true, 100));
                // Beta's row says nothing, and still costs what it listed.
                expect(screen.queryByText('app.discoverPriceChanged')).toBeNull();
                expect(screen.getAllByText('app.discoverJoinPaid').length).toBeGreaterThan(0);
            } finally {
                mockTranslator.t.mockImplementation((key) => key);
            }
        });
    });

    test("a different account sees none of the previous one's outcomes or dialogs", async () => {
        window.api.joinChallenge = joinMock().mockResolvedValue(
            invalid({ success: false, status: 'charged-pending-submit' }),
        );
        const view = render(<DiscoverSection isLoggedIn bankroll={invalid({ coins: 500 })} onJoined={jest.fn()} />);
        await screen.findByText('Paid One');
        fireEvent.click(screen.getByText('app.discoverJoinPaid'));
        await screen.findByText('app.discoverChargedPending');
        // Logged out, and in again as someone else.
        view.rerender(<DiscoverSection isLoggedIn={false} bankroll={null} onJoined={jest.fn()} />);
        view.rerender(<DiscoverSection isLoggedIn bankroll={invalid({ coins: 500 })} onJoined={jest.fn()} />);
        await screen.findByText('Paid One');
        expect(screen.queryByText('app.discoverChargedPending')).toBeNull();
        expect(screen.queryByText('app.discoverRetrySubmit')).toBeNull();
    });

    test('an answer from before the account changed is dropped: no dialog, no outcome line, no refetch, no onJoined', async () => {
        let release!: (answer: Awaited<ReturnType<WindowApi['joinChallenge']>>) => void;
        window.api.joinChallenge = joinMock().mockImplementation(() => new Promise((resolve) => (release = resolve)));
        const onJoined = jest.fn();
        const view = render(<DiscoverSection isLoggedIn bankroll={invalid({ coins: 500 })} onJoined={onJoined} />);
        await screen.findByText('Paid One');
        fireEvent.click(screen.getByText('app.discoverJoinPaid'));
        await waitFor(() => expect(window.api.joinChallenge).toHaveBeenCalledTimes(1));
        view.rerender(<DiscoverSection isLoggedIn={false} bankroll={null} onJoined={onJoined} />);
        view.rerender(<DiscoverSection isLoggedIn bankroll={invalid({ coins: 500 })} onJoined={onJoined} />);
        await screen.findByText('Paid One');
        const reads = jest.mocked(window.api.getMemberChallenges).mock.calls.length;
        // The previous account's join comes back saying coins were charged.
        await act(async () => release(invalid({ success: false, status: 'charged-pending-submit', cost: 100 })));
        expect(screen.queryByText('app.discoverChargedPending')).toBeNull();
        expect(screen.queryByText('app.discoverRetrySubmit')).toBeNull();
        expect(screen.queryByText('app.discoverConfirmTitle')).toBeNull();
        expect(jest.mocked(window.api.getMemberChallenges).mock.calls).toHaveLength(reads);
        expect(onJoined).not.toHaveBeenCalled();
        // The new session's row is not left busy by the old one either.
        expect(screen.getByText('app.discoverJoinPaid')).toBeTruthy();
    });

    test('an answer from before the account changed that asks for a price opens no dialog for the new account', async () => {
        let release!: (answer: Awaited<ReturnType<WindowApi['joinChallenge']>>) => void;
        window.api.joinChallenge = joinMock().mockImplementation(() => new Promise((resolve) => (release = resolve)));
        const view = render(<DiscoverSection isLoggedIn bankroll={invalid({ coins: 500 })} onJoined={jest.fn()} />);
        await screen.findByText('Paid One');
        fireEvent.click(screen.getByText('app.discoverJoinPaid'));
        await waitFor(() => expect(window.api.joinChallenge).toHaveBeenCalledTimes(1));
        view.rerender(<DiscoverSection isLoggedIn={false} bankroll={null} onJoined={jest.fn()} />);
        view.rerender(<DiscoverSection isLoggedIn bankroll={invalid({ coins: 500 })} onJoined={jest.fn()} />);
        await screen.findByText('Paid One');
        await act(async () => release(invalid(priceAsk(100))));
        expect(screen.queryByText('app.discoverConfirmTitle')).toBeNull();
    });

    test('a failed join that the old session threw is dropped too', async () => {
        let fail!: (error: Error) => void;
        window.api.joinChallenge = joinMock().mockImplementation(() => new Promise((_, reject) => (fail = reject)));
        const view = render(<DiscoverSection isLoggedIn bankroll={invalid({ coins: 500 })} onJoined={jest.fn()} />);
        await screen.findByText('Paid One');
        fireEvent.click(screen.getByText('app.discoverJoinPaid'));
        await waitFor(() => expect(window.api.joinChallenge).toHaveBeenCalledTimes(1));
        view.rerender(<DiscoverSection isLoggedIn={false} bankroll={null} onJoined={jest.fn()} />);
        view.rerender(<DiscoverSection isLoggedIn bankroll={invalid({ coins: 500 })} onJoined={jest.fn()} />);
        await screen.findByText('Paid One');
        await act(async () => fail(new Error('boom')));
        expect(screen.queryByText('boom')).toBeNull();
    });

    test('a retry of a paid join that is already charged says "Joining…", not "Checking…"', async () => {
        window.api.joinChallenge = spendLater({ status: 'charged-pending-submit', cost: 100 });
        render(<DiscoverSection isLoggedIn bankroll={invalid({ coins: 500 })} onJoined={jest.fn()} />);
        await screen.findByText('Paid One');
        fireEvent.click(screen.getByText('app.discoverJoinPaid'));
        fireEvent.click(await screen.findByText('app.discoverConfirmSpend'));
        await screen.findByText('app.discoverRetrySubmit');
        window.api.joinChallenge = joinMock().mockReturnValue(invalid(new Promise<never>(() => undefined)));
        fireEvent.click(screen.getByText('app.discoverRetrySubmit'));
        expect(await screen.findByText('app.discoverJoining')).toBeTruthy();
        expect(screen.queryByText('app.discoverChecking')).toBeNull();
    });

    test('an account that could not be identified says so, and the row can be tried again', async () => {
        window.api.joinChallenge = joinMock().mockResolvedValue(
            invalid({ success: false, status: 'failed-no-charge', reason: 'account-unknown', cost: 100 }),
        );
        render(<DiscoverSection isLoggedIn bankroll={invalid({ coins: 500 })} onJoined={jest.fn()} />);
        await screen.findByText('Paid One');
        fireEvent.click(screen.getByText('app.discoverJoinPaid'));
        const note = await screen.findByText('app.discoverAccountUnknown');
        expect(note.getAttribute('role')).toBe('alert');
        expect(screen.queryByText('app.discoverJoinFailed')).toBeNull();
        const again = screen.getByText<HTMLButtonElement>('app.discoverJoinPaid');
        expect(again.disabled).toBe(false);
        fireEvent.click(again);
        await waitFor(() => expect(window.api.joinChallenge).toHaveBeenCalledTimes(2));
    });

    test('an answer that arrives while a dialog is open, quoting another price, reprices nothing and tells its row to wait', async () => {
        const paid = (id: number, title: string, join_coins: number) => ({ ...items[1], id, title, join_coins });
        window.api.getMemberChallenges = listMock().mockResolvedValue(
            invalid({ success: true, items: [paid(11, 'Alpha', 100), paid(12, 'Beta', 200)] }),
        );
        let release!: () => void;
        let betaAsks = 0;
        window.api.joinChallenge = joinMock().mockImplementation((id) => {
            if (id === 11) return Promise.resolve(invalid(priceAsk(100)));
            // Beta's first ask finds coins already spent; its retry waits, then quotes a different price.
            if (betaAsks++ === 0) return Promise.resolve(invalid({ success: false, status: 'charged-pending-submit' }));
            return new Promise((resolve) => (release = () => resolve(invalid(priceAsk(250)))));
        });
        mockTranslator.t.mockImplementation((key) =>
            key === 'app.discoverConfirmBody' ? 'Join {title} for {coins}' : key,
        );
        try {
            render(<DiscoverSection isLoggedIn bankroll={invalid({ coins: 500 })} onJoined={jest.fn()} />);
            await screen.findByText('Alpha');
            const [alpha, beta] = screen.getAllByText('app.discoverJoinPaid');
            fireEvent.click(beta);
            await screen.findByText('app.discoverChargedPending');
            fireEvent.click(alpha);
            await screen.findByText('Join Alpha for 100');
            fireEvent.click(screen.getByText('app.discoverRetrySubmit'));
            await waitFor(() => expect(betaAsks).toBe(2));
            await act(async () => release());
            expect(screen.getByText('Join Alpha for 100')).toBeTruthy();
            expect(screen.queryByText('Join Beta for 250')).toBeNull();
            expect(screen.queryByText('app.discoverPriceChanged')).toBeNull();
            expect(screen.getByText('app.discoverConfirmDialogFirst')).toBeTruthy();
            expect(screen.queryByText('app.discoverChargedPending')).toBeNull();
        } finally {
            mockTranslator.t.mockImplementation((key) => key);
        }
    });

    test('a free row is joined as before, with no ask of its own', async () => {
        render(<DiscoverSection isLoggedIn bankroll={invalid({ coins: 500 })} onJoined={jest.fn()} />);
        await screen.findByText('Free One');
        fireEvent.click(screen.getByText('app.discoverJoin'));
        await screen.findByText('app.discoverJoined');
        expect(window.api.joinChallenge).toHaveBeenCalledTimes(1);
        expect(window.api.joinChallenge).toHaveBeenCalledWith(900001, false);
    });
});

describe('two joins at once', () => {
    const twoFree = invalid<OpenChallenge[]>([
        { ...items[0], id: 1, title: 'Alpha' },
        { ...items[0], id: 2, title: 'Beta' },
    ]);

    test('each row is busy for its own join only, and finishing one leaves the other busy', async () => {
        window.api.getMemberChallenges = listMock().mockResolvedValue(invalid({ success: true, items: twoFree }));
        const release: Record<number, () => void> = {};
        window.api.joinChallenge = joinMock().mockImplementation(
            (id) =>
                new Promise((resolve) => {
                    release[Number(id)] = () => resolve(invalid({ success: false, status: 'busy' }));
                }),
        );
        mockTranslator.t.mockImplementation((key) =>
            key === 'app.discoverJoinLabel' ? 'Join {title}' : key === 'app.discoverJoining' ? 'Joining…' : key,
        );
        try {
            render(<DiscoverSection isLoggedIn bankroll={invalid({ coins: 500 })} onJoined={jest.fn()} />);
            await screen.findByText('Alpha');
            fireEvent.click(screen.getByRole('button', { name: 'Join Alpha' }));
            fireEvent.click(screen.getByRole('button', { name: 'Join Beta' }));
            await waitFor(() => expect(screen.getAllByText('Joining…')).toHaveLength(2));

            // Beta finishes first: Beta is free again, Alpha is still joining and still cannot be pressed.
            await act(async () => release[2]());
            await waitFor(() => expect(screen.getAllByText('Joining…')).toHaveLength(1));
            expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Join Beta' }).disabled).toBe(false);
            const alpha = screen.getByText('Joining…').closest('li')!;
            expect(within(alpha).getByText('Alpha')).toBeTruthy();
            expect(within(alpha).getByText<HTMLButtonElement>('Joining…').disabled).toBe(true);

            await act(async () => release[1]());
            await waitFor(() => expect(screen.queryByText('Joining…')).toBeNull());
            expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Join Alpha' }).disabled).toBe(false);
        } finally {
            mockTranslator.t.mockImplementation((key) => key);
        }
    });
});

test('a free join sends no cost to confirm', async () => {
    render(<DiscoverSection isLoggedIn bankroll={invalid({ coins: 500 })} onJoined={jest.fn()} />);
    await screen.findByText('Free One');
    fireEvent.click(screen.getByText('app.discoverJoin'));
    await waitFor(() => expect(window.api.joinChallenge).toHaveBeenCalledWith(900001, false));
});

test('a statusless failure (auth expiry / handler error) still shows a message', async () => {
    window.api.joinChallenge = joinMock().mockResolvedValue(
        invalid({ success: false, error: 'No authentication token found' }),
    );
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
    // Only the ask went out: nothing was asked to be spent.
    expect(window.api.joinChallenge).toHaveBeenCalledTimes(1);
    expect(window.api.joinChallenge).toHaveBeenCalledWith(900002, false);
});

test('charged-pending-submit shows the distinct message + retry action', async () => {
    window.api.joinChallenge = spendLater({ status: 'charged-pending-submit', cost: 100 });
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
        window.api.getMemberChallenges = listMock().mockResolvedValue(invalid({ success: false, error: 'down' }));
        renderSection();
        expect(await screen.findByText('app.discoverUnavailableList', { selector: 'p' })).toBeTruthy();
        expect(screen.getByTitle('app.discoverUnavailableList').textContent).toBe('!');
        jest.mocked(window.api.getMemberChallenges).mockResolvedValue(invalid({ success: true, items }));
        fireEvent.click(screen.getByText('app.discoverRefresh'));
        await screen.findByText('Free One');
        expect(window.api.getMemberChallenges).toHaveBeenCalledTimes(2);
    });

    test('the error badge of the collapsed section has a text name', async () => {
        window.api.getMemberChallenges = listMock().mockResolvedValue(invalid({ success: false, error: 'down' }));
        renderSection();
        expect(await screen.findByRole('img', { name: 'app.discoverUnavailableList' })).toBeTruthy();
    });

    test('each Join button is named by its challenge, free or paid, and the busy one by its own text', async () => {
        mockTranslator.t.mockImplementation((key) =>
            key === 'app.discoverJoinLabel'
                ? 'Join {title}'
                : key === 'app.discoverJoinPaidLabel'
                  ? 'Join (paid) {title}, {coins} coins'
                  : key,
        );
        try {
            renderSection();
            await screen.findByText('Free One');
            expect(screen.getByRole('button', { name: 'Join Free One' })).toBeTruthy();
            // The label starts with the visible text, so voice control can still say what it sees.
            expect(screen.getByRole('button', { name: 'Join (paid) Paid One, 100 coins' })).toBeTruthy();
            // While joining, the visible text says so, so no static label contradicts it.
            let release!: (value: unknown) => void;
            jest.mocked(window.api.joinChallenge).mockReturnValue(
                invalid(new Promise((resolve) => (release = resolve))),
            );
            fireEvent.click(screen.getByRole('button', { name: 'Join Free One' }));
            expect(await screen.findByText('app.discoverJoining')).toBeTruthy();
            expect(screen.queryByRole('button', { name: 'Join Free One' })).toBeNull();
            await act(async () => release({ success: true, status: 'joined' }));
        } finally {
            mockTranslator.t.mockImplementation((key) => key);
        }
    });

    test('rows fall back from title to url to an untitled label', async () => {
        window.api.getMemberChallenges = listMock().mockResolvedValue(
            invalid({
                success: true,
                items: [
                    { id: 1, url: 'just-url', chosenOwn: [], chosenOwnCount: 0, chosenEffectiveCount: 0 },
                    { id: 2, join_coins: 'x', chosenOwn: [], chosenOwnCount: 0, chosenEffectiveCount: 0 },
                ],
            }),
        );
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
        window.api.joinChallenge = joinMock().mockResolvedValue(invalid({ success: false, status: 'unavailable' }));
        const { onJoined } = renderSection();
        await screen.findByText('Free One');
        fireEvent.click(screen.getByText('app.discoverJoin'));
        await screen.findByText('app.discoverUnavailable');
        await waitFor(() => expect(window.api.getMemberChallenges).toHaveBeenCalledTimes(2));
        expect(onJoined).not.toHaveBeenCalled();
    });

    test('a thrown join is reported as failed-no-charge; a statusless failure without text is generic', async () => {
        window.api.joinChallenge = joinMock().mockRejectedValue(new Error('ipc gone'));
        renderSection();
        await screen.findByText('Free One');
        fireEvent.click(screen.getByText('app.discoverJoin'));
        expect(await screen.findByText('app.discoverFailedNoCharge')).toBeTruthy();
        expect(screen.getByText<HTMLButtonElement>('app.discoverJoin').disabled).toBe(false);

        window.api.joinChallenge = joinMock().mockResolvedValue(invalid({ success: false }));
        fireEvent.click(screen.getByText('app.discoverJoin'));
        expect(await screen.findByText('app.discoverGenericError')).toBeTruthy();
    });

    test('an invalid-args failure shows the translated message, not the code', async () => {
        window.api.joinChallenge = joinMock().mockResolvedValue(invalid({ success: false, error: 'invalid-args' }));
        renderSection();
        await screen.findByText('Free One');
        fireEvent.click(screen.getByText('app.discoverJoin'));
        expect(await screen.findByText('errors.actionInvalidArgs')).toBeTruthy();
        expect(screen.queryByText('invalid-args')).toBeNull();
    });

    test('the join button reads Joining while in flight', async () => {
        let resolve: ((value: Awaited<ReturnType<WindowApi['joinChallenge']>>) => void) | undefined;
        window.api.joinChallenge = joinMock().mockImplementation(() => new Promise((r) => (resolve = r)));
        renderSection();
        await screen.findByText('Free One');
        fireEvent.click(screen.getByText('app.discoverJoin'));
        const joining = await screen.findByText<HTMLButtonElement>('app.discoverJoining');
        expect(joining.disabled).toBe(true);
        resolve!(invalid({ success: true, status: 'joined' }));
        await screen.findByText('app.discoverJoined');
    });

    test('retry submit asks again without spending: a server that holds the marker submits, and that is the outcome', async () => {
        window.api.joinChallenge = spendLater({ status: 'charged-pending-submit', cost: 100 });
        const { onJoined } = renderSection();
        await screen.findByText('Paid One');
        fireEvent.click(screen.getByText('app.discoverJoinPaid'));
        fireEvent.click(await screen.findByText('app.discoverConfirmSpend'));
        await screen.findByText('app.discoverRetrySubmit');
        jest.mocked(window.api.joinChallenge).mockResolvedValue(invalid({ success: true, status: 'joined' }));
        fireEvent.click(screen.getByText('app.discoverRetrySubmit'));
        await screen.findByText('app.discoverJoined');
        expect(window.api.joinChallenge).toHaveBeenLastCalledWith(900002, false);
        expect(onJoined).toHaveBeenCalledTimes(2);
    });

    test('retry submit with no marker behind it (another account, a lookup that blipped) opens the price dialog, spending nothing', async () => {
        window.api.joinChallenge = spendLater({ status: 'charged-pending-submit', cost: 100 });
        renderSection();
        await screen.findByText('Paid One');
        fireEvent.click(screen.getByText('app.discoverJoinPaid'));
        fireEvent.click(await screen.findByText('app.discoverConfirmSpend'));
        await screen.findByText('app.discoverRetrySubmit');
        const spent = () =>
            jest.mocked(window.api.joinChallenge).mock.calls.filter(([, spend]) => spend === true).length;
        expect(spent()).toBe(1);
        // The server no longer holds the marker: it asks for the price instead of unlocking.
        jest.mocked(window.api.joinChallenge).mockImplementation(async (_id, spendCoins) =>
            invalid(spendCoins ? { success: true, status: 'joined' } : priceAsk(100)),
        );
        fireEvent.click(screen.getByText('app.discoverRetrySubmit'));
        await screen.findByText('app.discoverConfirmTitle');
        expect(spent()).toBe(1);
        // The earlier "charged but not joined" line is gone: it would contradict the dialog.
        expect(screen.queryByText('app.discoverChargedPending')).toBeNull();
    });

    test('coins already spent but no photo qualifies: it says so, and offers no retry that cannot work', async () => {
        window.api.joinChallenge = joinMock().mockResolvedValue(
            invalid({ success: false, status: 'charged-pending-submit', reason: 'no-photo' }),
        );
        renderSection();
        await screen.findByText('Paid One');
        fireEvent.click(screen.getByText('app.discoverJoinPaid'));
        const note = await screen.findByText('app.discoverPendingNoPhoto');
        expect(note.getAttribute('role')).toBe('alert');
        expect(screen.queryByText('app.discoverChargedPending')).toBeNull();
        expect(screen.queryByText('app.discoverRetrySubmit')).toBeNull();
    });

    test('the Retry submit button is named by its challenge', async () => {
        window.api.joinChallenge = spendLater({ status: 'charged-pending-submit', cost: 100 });
        mockTranslator.t.mockImplementation((key) =>
            key === 'app.discoverRetrySubmitLabel' ? 'Retry submit for {title}' : key,
        );
        try {
            renderSection();
            await screen.findByText('Paid One');
            fireEvent.click(screen.getByText('app.discoverJoinPaid'));
            fireEvent.click(await screen.findByText('app.discoverConfirmSpend'));
            expect(await screen.findByRole('button', { name: 'Retry submit for Paid One' })).toBeTruthy();
        } finally {
            mockTranslator.t.mockImplementation((key) => key);
        }
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
        // Both times only the ask went out, and none of the calls was one that spends.
        expect(window.api.joinChallenge).toHaveBeenCalledTimes(2);
        expect(jest.mocked(window.api.joinChallenge).mock.calls.every(([, spendCoins]) => spendCoins === false)).toBe(
            true,
        );
    });

    test('an unknown balance says so and still allows the spend; a url-only paid challenge is named by url', async () => {
        window.api.getMemberChallenges = listMock().mockResolvedValue(
            invalid({
                success: true,
                items: [
                    {
                        id: 5,
                        url: 'paid-url',
                        join_coins: 10,
                        chosenOwn: [],
                        chosenOwnCount: 0,
                        chosenEffectiveCount: 0,
                    },
                ],
            }),
        );
        mockTranslator.t.mockImplementation((key) =>
            key === 'app.discoverConfirmBody' ? 'join {title} for {coins}' : key,
        );
        window.api.joinChallenge = spendLater({ success: true, status: 'joined' }, 10);
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
            return {
                ...c,
                chosenOwn: mine ?? [],
                chosenOwnCount: (mine ?? []).length,
                chosenEffectiveCount: (mine ?? globalList).length,
            };
        });

    beforeEach(() => {
        own = {};
        globalList = [];
        window.api = invalid({
            // The settings-only read subscribes to settings changes, as in the app.
            onSettingsChanged: mockApi.onSettingsChanged,
            getSetting: jest
                .fn<ReturnType<WindowApi['getSetting']>, Parameters<WindowApi['getSetting']>>()
                .mockResolvedValue(invalid('')),
            // The list is read once; the rows then follow the settings through the settings-only read.
            getMemberChallenges: listMock().mockResolvedValue(invalid({ success: true, items })),
            getOpenChosenAnnotations: jest.fn<
                ReturnType<WindowApi['getOpenChosenAnnotations']>,
                Parameters<WindowApi['getOpenChosenAnnotations']>
            >(async () => ({
                success: true,
                annotations: Object.fromEntries(
                    annotated().map(({ id, chosenOwn, chosenOwnCount, chosenEffectiveCount }) => [
                        String(id),
                        { chosenOwn, chosenOwnCount, chosenEffectiveCount },
                    ]),
                ),
            })),
            joinChallenge: spendLater({ success: true, status: 'joined' }),
            setChallengeOverride: jest.fn(async (_key: string, id: string, value: string[]) => {
                own[id] = value;
                return true;
            }),
            removeChallengeOverride: jest.fn(async (_key: string, id: string) => {
                delete own[id];
                return true;
            }),
            getLibraryPhotos: jest
                .fn<ReturnType<WindowApi['getLibraryPhotos']>, Parameters<WindowApi['getLibraryPhotos']>>()
                .mockResolvedValue({
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
        fireEvent.click(await screen.findByRole('button', { name: /^app\.photoChooserTileLabel/ }));
        fireEvent.click(screen.getByRole('button', { name: 'app.photoChooserUse' }));
        await waitFor(() =>
            expect(window.api.setChallengeOverride).toHaveBeenCalledWith('chosenPhotos', '900001', [PHOTO]),
        );
        // The settings are read again after the save, not the list from GuruShots: the row now
        // carries the chip, the other row does not.
        expect(await screen.findByText('app.discoverChosenChip')).toBeTruthy();
        expect(screen.getAllByText('app.discoverChosenChip')).toHaveLength(1);
        expect(window.api.getMemberChallenges).toHaveBeenCalledTimes(1);
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    });

    test('the Chosen chip reopens the chooser on the saved list; saving none removes the list', async () => {
        own['900001'] = [PHOTO];
        renderSection();
        fireEvent.click(await screen.findByText('app.discoverChosenChip'));
        const tile = await screen.findByRole('button', { name: /^app\.photoChooserTileLabel/ });
        expect(tile.getAttribute('aria-pressed')).toBe('true');
        fireEvent.click(tile);
        fireEvent.click(screen.getByRole('button', { name: 'app.photoChooserUse' }));
        await waitFor(() => expect(window.api.removeChallengeOverride).toHaveBeenCalledWith('chosenPhotos', '900001'));
        await waitFor(() => expect(screen.queryByText('app.discoverChosenChip')).toBeNull());
    });

    describe("the user's own list, withheld on a fresh launch", () => {
        const OWNER = 'c'.repeat(32);
        let memberKnown: boolean;
        let release: () => void;

        // The listing becomes ready, and the chooser then asks again for its own list: wait for that ask.
        const releaseAndWaitForReread = async () => {
            jest.mocked(window.api.getOpenChosenAnnotations).mockClear();
            release();
            await waitFor(() => expect(window.api.getOpenChosenAnnotations).toHaveBeenCalledWith(['900001']));
        };

        const open = async () => {
            own['900001'] = [PHOTO];
            memberKnown = false;
            const gate = new Promise<void>((resolve) => (release = resolve));
            jest.mocked(window.api.getSetting).mockResolvedValue(OWNER);
            // The main process withholds the ids until the listing has resolved the member.
            jest.mocked(window.api.getOpenChosenAnnotations).mockImplementation(async () => ({
                success: true,
                annotations: Object.fromEntries(
                    annotated().map(({ id, chosenOwn, chosenOwnCount, chosenEffectiveCount }) => [
                        String(id),
                        { chosenOwn: memberKnown ? chosenOwn : [], chosenOwnCount, chosenEffectiveCount },
                    ]),
                ),
            }));
            jest.mocked(window.api.getLibraryPhotos).mockImplementation(async () => {
                await gate;
                memberKnown = true;
                return {
                    success: true as const,
                    photos: [{ id: PHOTO, labels: ['sea'], allowed: true, message: null, uploadDate: 1 }],
                    memberId: OWNER,
                    truncated: false,
                    allowedKnown: true,
                };
            });
            renderSection();
            fireEvent.click(await screen.findByText('app.discoverChosenChip'));
            return screen.findByRole('button', { name: 'app.photoChooserUse' });
        };

        test('Save is held, an empty one included, until the list has been read again; then it saves that list', async () => {
            const use = await open();
            expect(use.getAttribute('aria-disabled')).toBe('true');
            fireEvent.click(use);
            expect(window.api.removeChallengeOverride).not.toHaveBeenCalled();
            expect(window.api.setChallengeOverride).not.toHaveBeenCalled();

            release();
            await waitFor(() =>
                expect(
                    screen.getByRole('button', { name: /^app\.photoChooserTileLabel/ }).getAttribute('aria-pressed'),
                ).toBe('true'),
            );
            await waitFor(() => expect(use.getAttribute('aria-disabled')).toBe('false'));
            fireEvent.click(use);
            await waitFor(() =>
                expect(window.api.setChallengeOverride).toHaveBeenCalledWith('chosenPhotos', '900001', [PHOTO]),
            );
            expect(window.api.removeChallengeOverride).not.toHaveBeenCalled();
        });

        test('a failed first read is not repeated by the section re-rendering: only Retry asks again', async () => {
            const use = await open();
            // The chooser's own read (one id) fails, so the ids stay withheld; the rows' read still
            // answers, with different data each time, so every settings broadcast really re-renders.
            const rowsRead = jest.mocked(window.api.getOpenChosenAnnotations).getMockImplementation()!;
            let rowReads = 0;
            jest.mocked(window.api.getOpenChosenAnnotations).mockImplementation(async (ids) => {
                if (ids.length === 1) return { success: false, error: 'down', annotations: {} };
                rowReads += 1;
                const answer = await rowsRead(ids);
                return answer.success
                    ? {
                          ...answer,
                          annotations: Object.fromEntries(
                              Object.entries(answer.annotations).map(([id, row]) => [
                                  id,
                                  { ...row, chosenEffectiveCount: row.chosenEffectiveCount + (rowReads % 2) },
                              ]),
                          ),
                      }
                    : answer;
            });
            await releaseAndWaitForReread();
            await screen.findByText('app.photoChooserSaveReadFailed');
            const ownReads = () =>
                jest.mocked(window.api.getOpenChosenAnnotations).mock.calls.filter(([ids]) => ids.length === 1);
            expect(ownReads()).toHaveLength(1);

            // Settings broadcasts re-render the section; the chooser's read is not asked again.
            const before = rowReads;
            act(() => fireSettingsChanged({ theme: 'dark' }));
            await waitFor(() => expect(rowReads).toBe(before + 1));
            act(() => fireSettingsChanged({ theme: 'light' }));
            await waitFor(() => expect(rowReads).toBe(before + 2));
            await act(async () => undefined);
            expect(ownReads()).toHaveLength(1);
            expect(screen.getByText('app.photoChooserSaveReadFailed')).toBeTruthy();
            expect(use.getAttribute('aria-disabled')).toBe('true');
        });

        test('the list is removed only when the user really clears it', async () => {
            const use = await open();
            release();
            await waitFor(() => expect(use.getAttribute('aria-disabled')).toBe('false'));
            fireEvent.click(screen.getByRole('button', { name: 'app.photosClear' }));
            fireEvent.click(use);
            await waitFor(() =>
                expect(window.api.removeChallengeOverride).toHaveBeenCalledWith('chosenPhotos', '900001'),
            );
        });

        test.each([
            ['an answer that does not hold the row', {}],
            [
                'an answer that still withholds the ids',
                { '900001': { chosenOwn: [], chosenOwnCount: 1, chosenEffectiveCount: 1 } },
            ],
        ])('%s keeps Save held', async (_name, annotations) => {
            const use = await open();
            jest.mocked(window.api.getOpenChosenAnnotations).mockResolvedValue(invalid({ success: true, annotations }));
            await releaseAndWaitForReread();
            await screen.findByRole('button', { name: /^app\.photoChooserTileLabel/ });
            expect(use.getAttribute('aria-disabled')).toBe('true');
            fireEvent.click(use);
            expect(window.api.removeChallengeOverride).not.toHaveBeenCalled();
        });

        test('a read that throws keeps Save held', async () => {
            const use = await open();
            jest.mocked(window.api.getOpenChosenAnnotations).mockRejectedValue(new Error('gone'));
            await releaseAndWaitForReread();
            await screen.findByRole('button', { name: /^app\.photoChooserTileLabel/ });
            expect(use.getAttribute('aria-disabled')).toBe('true');
        });

        test('a read that fails keeps Save held', async () => {
            const use = await open();
            jest.mocked(window.api.getOpenChosenAnnotations).mockResolvedValue({
                success: false,
                error: 'down',
                annotations: {},
            });
            await releaseAndWaitForReread();
            await screen.findByRole('button', { name: /^app\.photoChooserTileLabel/ });
            expect(use.getAttribute('aria-disabled')).toBe('true');
            fireEvent.click(use);
            expect(window.api.removeChallengeOverride).not.toHaveBeenCalled();
        });
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
            expect(await screen.findByRole('button', { name: 'Chosen photos for Free One' })).toBeTruthy();
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
        fireEvent.click(await screen.findByRole('button', { name: /^app\.photoChooserTileLabel/ }));
        fireEvent.click(screen.getByRole('button', { name: 'app.photoChooserUse' }));
        expect((await screen.findByRole('alert')).textContent).toContain('app.photoChooserSaveError');
        expect(screen.queryByText('app.discoverChosenChip')).toBeNull();
    });

    test('a save the bridge rejects counts as refused', async () => {
        jest.mocked(window.api.setChallengeOverride).mockRejectedValue(new Error('down'));
        renderSection();
        await screen.findByText('Free One');
        fireEvent.click(screen.getAllByText('app.choosePhotos')[0]);
        fireEvent.click(await screen.findByRole('button', { name: /^app\.photoChooserTileLabel/ }));
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
        await waitFor(() => expect(screen.getAllByText('app.discoverChosenInherited')).toHaveLength(2));
        expect(screen.queryByText('app.discoverChosenChip')).toBeNull();
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

    test("another account's list is only counted: remove, cancel, reopen, and its ids never appear", async () => {
        // The main process withholds a foreign list's ids and counts them; the owner is on record.
        let foreign = true;
        own['900001'] = [PHOTO];
        jest.mocked(window.api.getSetting).mockResolvedValue('d'.repeat(32));
        jest.mocked(window.api.getOpenChosenAnnotations).mockImplementation(async () => ({
            success: true,
            annotations: Object.fromEntries(
                annotated().map((row) => [
                    String(row.id),
                    {
                        chosenOwn: foreign ? [] : row.chosenOwn,
                        chosenOwnCount: row.chosenOwnCount,
                        chosenEffectiveCount: foreign ? 0 : row.chosenEffectiveCount,
                    },
                ]),
            ),
        }));
        window.api.clearChosenPhotos = jest.fn(async () => {
            own = {};
            foreign = false;
            return { success: true as const, removed: 1 };
        });
        mockTranslator.t.mockImplementation((key) =>
            key.startsWith('app.') ? ((app as Record<string, string>)[key.slice(4)] ?? key) : key,
        );
        renderSection();
        // The row counts another account's list instead of calling it chosen photos.
        const chip = await screen.findByText('Other account: 1 photo(s)');
        expect(screen.queryByText('app.discoverChosenChip')).toBeNull();
        // A short chip text (the long sentence is its accessible name), so it stays one line in a narrow row.
        expect(chip.textContent!.length).toBeLessThan(chip.getAttribute('aria-label')!.length / 2);
        // Its own translated name and tooltip, not a string built in code.
        expect(chip.getAttribute('aria-label')).toBe('Other account: 1 photo(s) for Free One, review them');
        // WCAG 2.5.3: the accessible name starts with the text that is shown.
        expect(chip.getAttribute('aria-label')!.startsWith(chip.textContent!)).toBe(true);
        expect(chip.getAttribute('title')).toBe(app.discoverChosenForeignHint);
        mockTranslator.t.mockImplementation((key) => key);
        fireEvent.click(chip);
        // The chooser opens empty, with the notice and a count — never the other account's id.
        expect(await screen.findByText('app.photoChooserOtherAccount')).toBeTruthy();
        expect(screen.getByText('app.chosenPhotosOtherAccountCount')).toBeTruthy();
        expect(document.body.textContent).not.toContain(PHOTO.slice(0, 8));
        fireEvent.click(screen.getByRole('button', { name: 'app.photoChooserOtherAccountClear' }));
        const confirm = (await screen.findAllByRole('button', { name: 'app.photoChooserOtherAccountClear' })).at(-1)!;
        fireEvent.click(confirm);
        await waitFor(() => expect(window.api.clearChosenPhotos).toHaveBeenCalledTimes(1));
        fireEvent.click((await screen.findAllByRole('button', { name: 'app.cancel' })).at(-1)!);
        await waitFor(() => expect(screen.queryByRole('button', { name: 'app.photoChooserUse' })).toBeNull());
        // The row no longer carries the chip, and reopening shows a clean chooser.
        await waitFor(() => expect(screen.queryByText('app.discoverChosenChip')).toBeNull());
        fireEvent.click(screen.getAllByText('app.choosePhotos')[0]);
        await screen.findByRole('button', { name: 'app.photoChooserUse' });
        expect(screen.queryByText('app.photoChooserOtherAccount')).toBeNull();
        expect(document.body.textContent).not.toContain(PHOTO.slice(0, 8));
    });

    test('a settings change updates the rows without asking GuruShots again', async () => {
        renderSection();
        await screen.findByText('Free One');
        expect(screen.queryByText('app.discoverChosenChip')).toBeNull();
        own['900001'] = [PHOTO];
        act(() => fireSettingsChanged({}));
        expect(await screen.findByText('app.discoverChosenChip')).toBeTruthy();
        expect(window.api.getMemberChallenges).toHaveBeenCalledTimes(1);
    });

    test('when the settings read fails, the rows keep what the list carried', async () => {
        const carried = { ...items[0], chosenOwn: [PHOTO], chosenOwnCount: 1, chosenEffectiveCount: 1 };
        window.api.getMemberChallenges = listMock().mockResolvedValue(invalid({ success: true, items: [carried] }));
        jest.mocked(window.api.getOpenChosenAnnotations).mockResolvedValue(
            invalid({ success: false, error: 'invalid-args' }),
        );
        renderSection();
        expect(await screen.findByText('app.discoverChosenChip')).toBeTruthy();
        await waitFor(() => expect(window.api.getOpenChosenAnnotations).toHaveBeenCalled());
        expect(screen.getByText('app.discoverChosenChip')).toBeTruthy();
    });

    test('with no open challenges there is nothing to ask the settings about', async () => {
        window.api.getMemberChallenges = listMock().mockResolvedValue(invalid({ success: true, items: [] }));
        renderSection();
        await screen.findByText('app.discoverEmpty');
        expect(window.api.getOpenChosenAnnotations).not.toHaveBeenCalled();
    });

    test('a different set of open challenges asks again for exactly those ids', async () => {
        renderSection();
        await screen.findByText('Free One');
        await waitFor(() => expect(window.api.getOpenChosenAnnotations).toHaveBeenCalledWith(['900001', '900002']));
        const third = { ...items[0], id: 900003, title: 'Third One', chosenOwn: [], chosenOwnCount: 0 };
        window.api.getMemberChallenges = listMock().mockResolvedValue(
            invalid({ success: true, items: [items[0], third] }),
        );
        fireEvent.click(screen.getByText('app.discoverRefresh'));
        await screen.findByText('Third One');
        await waitFor(() => expect(window.api.getOpenChosenAnnotations).toHaveBeenLastCalledWith(['900001', '900003']));
    });

    test('a row whose own list is empty reads as having none', async () => {
        own['900002'] = [];
        renderSection();
        await screen.findByText('Paid One');
        expect(screen.queryByText('app.discoverChosenChip')).toBeNull();
        expect(screen.queryByText('app.discoverChosenInherited')).toBeNull();
    });
});
