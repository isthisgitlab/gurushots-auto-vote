/**
 * Component tests for DiscoverSection: free joins call joinChallenge directly;
 * paid joins go through the confirm modal and only spend on confirm. The
 * translation manager returns keys verbatim in tests, so buttons are matched by
 * their i18n key text.
 */

import { act, render, screen, fireEvent, waitFor } from './helpers/test-utils';
import { DiscoverSection } from '@/components/app/DiscoverSection';
import { fireSettingsChanged, mockApi, mockTranslator } from './helpers/setup';
import { invalid } from '../helpers/invalid';
import { app } from '../../src/ts/translations/english';
import type { OpenChallenge } from '../../src/ts/types/gurushots';
import type { WindowApi } from '../../src/ts/types/ipc';

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

    test('the error badge of the collapsed section has a text name', async () => {
        window.api.getMemberChallenges = jest.fn().mockResolvedValue({ success: false, error: 'down' });
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
        window.api.getMemberChallenges = jest.fn().mockResolvedValue({
            success: true,
            items: [
                { id: 1, url: 'just-url', chosenOwn: [], chosenOwnCount: 0, chosenEffectiveCount: 0 },
                { id: 2, join_coins: 'x', chosenOwn: [], chosenOwnCount: 0, chosenEffectiveCount: 0 },
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

    test('the Retry submit button is named by its challenge', async () => {
        window.api.joinChallenge = jest.fn().mockResolvedValue({ status: 'charged-pending-submit', cost: 100 });
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
        expect(window.api.joinChallenge).not.toHaveBeenCalled();
    });

    test('an unknown balance says so and still allows the spend; a url-only paid challenge is named by url', async () => {
        window.api.getMemberChallenges = jest.fn().mockResolvedValue({
            success: true,
            items: [
                { id: 5, url: 'paid-url', join_coins: 10, chosenOwn: [], chosenOwnCount: 0, chosenEffectiveCount: 0 },
            ],
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
            getSetting: jest.fn().mockResolvedValue(''),
            // The list is read once; the rows then follow the settings through the settings-only read.
            getMemberChallenges: jest.fn(async () => ({ success: true, items: items })),
            getOpenChosenAnnotations: jest.fn(async () => ({
                success: true,
                annotations: Object.fromEntries(
                    annotated().map(({ id, chosenOwn, chosenOwnCount, chosenEffectiveCount }) => [
                        String(id),
                        { chosenOwn, chosenOwnCount, chosenEffectiveCount },
                    ]),
                ),
            })),
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
        const tile = await screen.findByRole('button', { name: 'app.photoChooserTileLabel' });
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
                    screen.getByRole('button', { name: 'app.photoChooserTileLabel' }).getAttribute('aria-pressed'),
                ).toBe('true'),
            );
            await waitFor(() => expect(use.getAttribute('aria-disabled')).toBe('false'));
            fireEvent.click(use);
            await waitFor(() =>
                expect(window.api.setChallengeOverride).toHaveBeenCalledWith('chosenPhotos', '900001', [PHOTO]),
            );
            expect(window.api.removeChallengeOverride).not.toHaveBeenCalled();
        });

        test('the saved list is read again once per opening, however often the section re-renders', async () => {
            const use = await open();
            release();
            await waitFor(() => expect(use.getAttribute('aria-disabled')).toBe('false'));
            // Settings changes re-render the section (and re-read the rows), but not the chooser's own read.
            act(() => fireSettingsChanged({ theme: 'dark' }));
            act(() => fireSettingsChanged({ theme: 'light' }));
            await waitFor(() => expect(window.api.getOpenChosenAnnotations).toHaveBeenCalledTimes(4));
            const own = jest.mocked(window.api.getOpenChosenAnnotations).mock.calls.filter(([ids]) => ids.length === 1);
            expect(own).toEqual([[['900001']]]);
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
            jest.mocked(window.api.getOpenChosenAnnotations).mockResolvedValue({ success: true, annotations });
            await releaseAndWaitForReread();
            await screen.findByRole('button', { name: 'app.photoChooserTileLabel' });
            expect(use.getAttribute('aria-disabled')).toBe('true');
            fireEvent.click(use);
            expect(window.api.removeChallengeOverride).not.toHaveBeenCalled();
        });

        test('a read that throws keeps Save held', async () => {
            const use = await open();
            jest.mocked(window.api.getOpenChosenAnnotations).mockRejectedValue(new Error('gone'));
            await releaseAndWaitForReread();
            await screen.findByRole('button', { name: 'app.photoChooserTileLabel' });
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
            await screen.findByRole('button', { name: 'app.photoChooserTileLabel' });
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
        window.api.getMemberChallenges = jest.fn().mockResolvedValue({ success: true, items: [carried] });
        jest.mocked(window.api.getOpenChosenAnnotations).mockResolvedValue({ success: false, error: 'invalid-args' });
        renderSection();
        expect(await screen.findByText('app.discoverChosenChip')).toBeTruthy();
        await waitFor(() => expect(window.api.getOpenChosenAnnotations).toHaveBeenCalled());
        expect(screen.getByText('app.discoverChosenChip')).toBeTruthy();
    });

    test('with no open challenges there is nothing to ask the settings about', async () => {
        window.api.getMemberChallenges = jest.fn().mockResolvedValue({ success: true, items: [] });
        renderSection();
        await screen.findByText('app.discoverEmpty');
        expect(window.api.getOpenChosenAnnotations).not.toHaveBeenCalled();
    });

    test('a different set of open challenges asks again for exactly those ids', async () => {
        renderSection();
        await screen.findByText('Free One');
        await waitFor(() => expect(window.api.getOpenChosenAnnotations).toHaveBeenCalledWith(['900001', '900002']));
        const third = { ...items[0], id: 900003, title: 'Third One', chosenOwn: [], chosenOwnCount: 0 };
        window.api.getMemberChallenges = jest.fn().mockResolvedValue({ success: true, items: [items[0], third] });
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
