/**
 * PhotoSubmitModal: the "Pick…" submit picker. The picker's own tiles (not numbered), a live cap that
 * can shrink while it is open, one-slot swapping, an inline error, a reload after a failure the card
 * refreshed for, and no way out while a submit is in flight. Translations are the real English strings.
 */

import { act, fireEvent, render, screen, waitFor, within } from './helpers/test-utils';
import { PICK_TEXTS, PhotoSubmitModal } from '@/components/app/PhotoSubmitModal';
import type { PickOutcome } from '@/components/app/PhotoSubmitModal';
import { rememberCurrentMember } from '@/api/useChosenPhotosOwner';
import { mockTranslator } from './helpers/setup';
import { app, errors } from '../../src/ts/translations/english';
import { invalid } from '../helpers/invalid';
import type { WindowApi } from '../../src/ts/types/ipc';

type Listing = Extract<Awaited<ReturnType<WindowApi['getLibraryPhotos']>>, { success: true }>;
type LibraryPhoto = Listing['photos'][number];

const MEMBER = 'c'.repeat(32);
const idOf = (n: number) => `${String(n).padStart(8, '0')}${'a'.repeat(24)}`;
const shortOf = (n: number) => String(n).padStart(8, '0');

const photo = (n: number, over: Partial<LibraryPhoto> = {}): LibraryPhoto => ({
    id: idOf(n),
    labels: [`tag${n}`],
    allowed: true,
    message: null,
    uploadDate: 1,
    ...over,
});

const listing = (photos: LibraryPhoto[], over: Partial<Listing> = {}): Listing => ({
    success: true,
    photos,
    memberId: MEMBER,
    truncated: false,
    wonIds: [],
    wonCount: 0,
    preview: false,
    readAtMs: 1_700_000_000_000,
    allowedKnown: true,
    ...over,
});

const english = (key: string) =>
    key.startsWith('app.')
        ? ((app as Record<string, string>)[key.slice(4)] ?? key)
        : key.startsWith('errors.')
          ? ((errors as Record<string, string>)[key.slice(7)] ?? key)
          : key;

const getLibrary = () => jest.mocked(window.api.getLibraryPhotos);

const tile = (n: number) => screen.getByRole('button', { name: new RegExp(`^Photo ${shortOf(n)}:`) });
// The listing the opening shows first is a preview, with picking held; the fresh read that follows unlocks it.
const opened = async () => {
    await screen.findByRole('button', { name: /^Photo 00000001:/ });
    await waitFor(() => expect(tile(1).textContent).toContain('Can be entered'));
};
// Pick… opens with nothing loaded: Load all reads the library, then the same wait as above.
const loadAll = () => fireEvent.click(screen.getByRole('button', { name: 'Load all photos' }));
const loadedAll = async () => {
    loadAll();
    await opened();
};
const submitButton = () => screen.getByRole('button', { name: /^Submit/ });
const countLine = () => screen.getAllByRole('status')[0];

type Props = Parameters<typeof PhotoSubmitModal>[0];
const baseProps = (over: Partial<Props> = {}): Props => ({
    isOpen: true,
    onClose: jest.fn(),
    challengeId: 7,
    max: 3,
    submitting: false,
    error: null,
    onSubmit: jest.fn<Promise<PickOutcome>, [string[]]>().mockResolvedValue('done'),
    ...over,
});
const setup = (over: Partial<Props> = {}) => {
    const props = baseProps(over);
    const utils = render(<PhotoSubmitModal {...props} />);
    return {
        props,
        ...utils,
        update: (next: Partial<Props>) => utils.rerender(<PhotoSubmitModal {...props} {...next} />),
    };
};

// Opened and asked for the whole library, as most of these cases start.
const setupLoaded = (over: Partial<Props> = {}) => {
    const utils = setup(over);
    loadAll();
    return utils;
};

beforeEach(() => {
    mockTranslator.t.mockImplementation(english);
    rememberCurrentMember(null);
    getLibrary().mockResolvedValue(listing([photo(1), photo(2), photo(3), photo(4)]));
});

afterEach(() => {
    mockTranslator.t.mockImplementation((key) => key);
});

describe('opening', () => {
    test('renders nothing while closed and reads no listing', () => {
        setup({ isOpen: false });
        expect(document.body.querySelector('[role="dialog"]')).toBeNull();
        expect(getLibrary()).not.toHaveBeenCalled();
    });

    test('reads the listing for the challenge and starts with nothing picked and Submit held', async () => {
        setupLoaded();
        await opened();
        expect(getLibrary().mock.calls).toEqual([
            [7, undefined, 'cached', 'submit'],
            [7, undefined, 'fresh', 'submit'],
        ]);
        expect(screen.getByText('Choose photos to submit')).toBeTruthy();
        expect(countLine().textContent).toBe('Picked: 0/3 open slots');
        expect(submitButton().hasAttribute('disabled')).toBe(true);
        expect(submitButton().textContent).toBe('Submit');
    });

    test('Submit sits in a footer pinned to the bottom of the modal box, which keeps focus above it', async () => {
        setupLoaded();
        await opened();
        const footer = submitButton().closest('.sticky')!;
        expect(footer.parentElement!.lastElementChild).toBe(footer);
        const box = document.querySelector('.modal-box')!;
        expect(box.lastElementChild).toBe(footer.parentElement);
        const boxClasses = box.classList;
        expect(boxClasses.contains('scroll-pb-60')).toBe(true);
        expect(boxClasses.contains('md:scroll-pb-32')).toBe(true);
    });

    test('picked tiles are not numbered', async () => {
        setupLoaded();
        await opened();
        fireEvent.click(tile(2));
        expect(tile(2).getAttribute('aria-pressed')).toBe('true');
        expect(tile(2).getAttribute('aria-label')).not.toMatch(/Number/);
        expect(tile(2).querySelector('.badge')).toBeNull();
    });
});

describe('picking and submitting', () => {
    test('Submit names the count and sends the picked ids in the order picked', async () => {
        const { props } = setupLoaded();
        await opened();
        fireEvent.click(tile(3));
        fireEvent.click(tile(1));
        expect(submitButton().textContent).toBe('Submit 2');
        expect(countLine().textContent).toBe('Picked: 2/3 open slots');
        fireEvent.click(submitButton());
        await waitFor(() => expect(props.onSubmit).toHaveBeenCalledWith([idOf(3), idOf(1)]));
        // Done: the card closes it, and nothing is read again.
        expect(getLibrary()).toHaveBeenCalledTimes(2);
    });

    test('a pick can be taken back', async () => {
        setupLoaded();
        await opened();
        fireEvent.click(tile(1));
        fireEvent.click(tile(1));
        expect(tile(1).getAttribute('aria-pressed')).toBe('false');
        expect(submitButton().hasAttribute('disabled')).toBe(true);
    });

    test('at the cap the other tiles are held and say the open slots are all picked', async () => {
        setupLoaded({ max: 2 });
        await opened();
        fireEvent.click(tile(1));
        fireEvent.click(tile(2));
        expect(tile(3).getAttribute('aria-disabled')).toBe('true');
        expect(tile(3).textContent).toContain('All open slots picked');
        fireEvent.click(tile(3));
        expect(countLine().textContent).toBe('Picked: 2/2 open slots');
    });

    test('with one open slot a tap swaps the pick instead of being refused', async () => {
        const { props } = setupLoaded({ max: 1 });
        await opened();
        fireEvent.click(tile(1));
        fireEvent.click(tile(2));
        expect(tile(1).getAttribute('aria-pressed')).toBe('false');
        expect(tile(2).getAttribute('aria-pressed')).toBe('true');
        expect(tile(3).getAttribute('aria-disabled')).toBe('false');
        fireEvent.click(submitButton());
        await waitFor(() => expect(props.onSubmit).toHaveBeenCalledWith([idOf(2)]));
    });

    test('a refreshed failure reads the listing again, keeping the search and the picks', async () => {
        const onSubmit = jest.fn<Promise<PickOutcome>, [string[]]>().mockResolvedValue('refreshed');
        setupLoaded({ onSubmit });
        await opened();
        fireEvent.change(screen.getByLabelText('Search your photos by tag'), { target: { value: 'sun' } });
        fireEvent.click(screen.getByRole('button', { name: 'Search' }));
        await waitFor(() => expect(getLibrary()).toHaveBeenLastCalledWith(7, 'sun', 'fresh', 'submit'));
        await opened();
        fireEvent.click(tile(2));
        fireEvent.click(submitButton());
        await waitFor(() => expect(getLibrary()).toHaveBeenCalledTimes(4));
        expect(getLibrary()).toHaveBeenLastCalledWith(7, 'sun', 'fresh', 'submit');
        await opened();
        expect(tile(2).getAttribute('aria-pressed')).toBe('true');
    });

    test('after a refreshed failure Submit stays held until the re-read listing is in', async () => {
        const onSubmit = jest.fn<Promise<PickOutcome>, [string[]]>().mockResolvedValue('refreshed');
        setupLoaded({ onSubmit });
        await opened();
        fireEvent.click(tile(1));
        let answer: (value: Listing) => void = () => undefined;
        getLibrary().mockReturnValueOnce(new Promise<Listing>((resolve) => (answer = resolve)));
        fireEvent.click(submitButton());
        await waitFor(() => expect(getLibrary()).toHaveBeenCalledTimes(3));
        expect(submitButton().hasAttribute('disabled')).toBe(true);
        fireEvent.click(submitButton());
        expect(onSubmit).toHaveBeenCalledTimes(1);
        await act(async () => answer(listing([photo(1), photo(2)])));
        await opened();
        expect(submitButton().hasAttribute('disabled')).toBe(false);
    });

    // A pick the listing marks refused stays on screen until it is pruned; once it has left the pick, the grid hides it.
    test('after a refreshed failure a picked photo the listing says is not allowed leaves the pick', async () => {
        const onSubmit = jest.fn<Promise<PickOutcome>, [string[]]>().mockResolvedValue('refreshed');
        setupLoaded({ onSubmit });
        await opened();
        fireEvent.click(tile(1));
        fireEvent.click(tile(2));
        getLibrary().mockResolvedValue(listing([photo(1), photo(2, { allowed: false }), photo(3)]));
        fireEvent.click(submitButton());
        await waitFor(() => expect(submitButton().textContent).toBe('Submit 1'));
        expect(screen.queryByRole('button', { name: new RegExp(`^Photo ${shortOf(2)}:`) })).toBeNull();
        expect(tile(1).getAttribute('aria-pressed')).toBe('true');
    });

    test('after a refreshed failure a picked photo the re-read listing reports as won leaves the pick', async () => {
        const onSubmit = jest.fn<Promise<PickOutcome>, [string[]]>().mockResolvedValue('refreshed');
        setupLoaded({ onSubmit });
        await opened();
        fireEvent.click(tile(1));
        fireEvent.click(tile(2));
        // Photo 2 won between the reads: the listing leaves it out, so `known` still has it as allowed.
        getLibrary().mockResolvedValue(listing([photo(1), photo(3)], { wonIds: [idOf(2)], wonCount: 1 }));
        fireEvent.click(submitButton());
        // Only photo 1 is still picked; the won photo is no longer listed or held.
        await waitFor(() => expect(submitButton().textContent).toBe('Submit 1'));
        expect(tile(1).getAttribute('aria-pressed')).toBe('true');
        expect(screen.queryByRole('button', { name: new RegExp(`${shortOf(2)}:`) })).toBeNull();
    });

    test.each([
        ['allows', listing([photo(1), photo(2), photo(3)])],
        [
            'cannot judge (no allowed flags)',
            listing([photo(1, { allowed: false }), photo(2, { allowed: false })], { allowedKnown: false }),
        ],
    ])('a refreshed failure keeps every pick the re-read listing %s', async (_label, reread) => {
        const onSubmit = jest.fn<Promise<PickOutcome>, [string[]]>().mockResolvedValue('refreshed');
        setupLoaded({ onSubmit });
        await opened();
        fireEvent.click(tile(1));
        fireEvent.click(tile(2));
        let answer: (value: Listing) => void = () => undefined;
        getLibrary().mockReturnValueOnce(new Promise<Listing>((resolve) => (answer = resolve)));
        fireEvent.click(submitButton());
        await waitFor(() => expect(getLibrary()).toHaveBeenCalledTimes(3));
        await waitFor(() => expect(screen.queryByRole('button', { name: /^Photo 00000001:/ })).toBeNull());
        await act(async () => answer(reread));
        await screen.findByRole('button', { name: /^Photo 00000001:/ });
        // The listing's effects (the prune) run after the tiles appear.
        await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
        expect(tile(1).getAttribute('aria-pressed')).toBe('true');
        expect(tile(2).getAttribute('aria-pressed')).toBe('true');
        expect(submitButton().textContent).toBe('Submit 2');
    });

    test('the picks do not change while a submit is in flight', async () => {
        const { update } = setupLoaded();
        await opened();
        fireEvent.click(tile(1));
        update({ submitting: true });
        fireEvent.click(tile(2));
        fireEvent.click(tile(1));
        expect(tile(1).getAttribute('aria-pressed')).toBe('true');
        expect(tile(2).getAttribute('aria-pressed')).toBe('false');
        update({ submitting: false });
        fireEvent.click(tile(2));
        expect(tile(2).getAttribute('aria-pressed')).toBe('true');
    });

    test('a pick the last loaded listing lacks stays put when its tile is tapped while a submit is in flight', async () => {
        const { update } = setupLoaded();
        await opened();
        fireEvent.click(tile(1));
        // A search comes back as a preview without photo 1 and the check of it fails: its tile is held but tappable.
        getLibrary()
            .mockResolvedValueOnce(listing([photo(2)]))
            .mockResolvedValueOnce(invalid({ success: false, error: 'down' }));
        fireEvent.click(screen.getByRole('button', { name: 'Search' }));
        const pending = await screen.findByRole('button', {
            name: /Not among your photos as last loaded\. Press Refresh/,
        });
        update({ submitting: true });
        fireEvent.click(pending);
        expect(pending.getAttribute('aria-pressed')).toBe('true');
        update({ submitting: false });
        fireEvent.click(pending);
        expect(screen.queryByRole('button', { name: /Press Refresh/ })).toBeNull();
    });

    test('a failure that changed nothing does not read the listing again', async () => {
        const onSubmit = jest.fn<Promise<PickOutcome>, [string[]]>().mockResolvedValue('failed');
        setupLoaded({ onSubmit });
        await opened();
        fireEvent.click(tile(1));
        fireEvent.click(submitButton());
        await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
        await act(async () => undefined);
        expect(getLibrary()).toHaveBeenCalledTimes(2);
    });

    test('a search that no longer lists a picked photo keeps the pick', async () => {
        const { props } = setupLoaded();
        await opened();
        fireEvent.click(tile(1));
        getLibrary().mockResolvedValue(listing([photo(2)]));
        fireEvent.click(screen.getByRole('button', { name: 'Search' }));
        await waitFor(() => expect(screen.queryByRole('button', { name: /^Photo 00000003:/ })).toBeNull());
        await screen.findByRole('button', { name: /^Photo 00000002:/ });
        expect(tile(1).getAttribute('aria-pressed')).toBe('true');
        fireEvent.click(submitButton());
        await waitFor(() => expect(props.onSubmit).toHaveBeenCalledWith([idOf(1)]));
    });
});

describe('a listing as last loaded, and Refresh', () => {
    const deferred = <T,>() => {
        let resolve!: (value: T) => void;
        const promise = new Promise<T>((r) => (resolve = r));
        return { promise, resolve };
    };
    const failure = invalid<Awaited<ReturnType<WindowApi['getLibraryPhotos']>>>({
        success: false,
        error: 'Failed to read your photo library',
    });
    const refreshButton = () => screen.getByRole('button', { name: 'Refresh photos' });
    const LOCKED = 'Locked while the app checks whether this challenge accepts it.';

    test('opens with the cached listing as a preview: no marks, picking and Submit held, until the fresh read lands', async () => {
        const fresh = deferred<Listing>();
        // The cache holds a listing with marks, as a join a moment ago would have left it out of date.
        getLibrary()
            .mockResolvedValueOnce(listing([photo(1, { allowed: false, message: 'Already used' }), photo(2)]))
            .mockReturnValueOnce(fresh.promise);
        setupLoaded();
        await screen.findByRole('button', { name: /^Photo 00000001:/ });
        expect(
            screen
                .getByText(/^Showing your photos as last loaded\. You can pick once the app has checked/)
                .getAttribute('role'),
        ).toBe('status');
        expect(screen.queryByText('Already used')).toBeNull();
        expect(tile(2).textContent).toContain(LOCKED);
        expect(tile(2).getAttribute('aria-disabled')).toBe('true');
        fireEvent.click(tile(2));
        expect(tile(2).getAttribute('aria-pressed')).toBe('false');
        expect(submitButton().hasAttribute('disabled')).toBe(true);
        expect(refreshButton().getAttribute('aria-busy')).toBe('true');
        // The preview lists photo 1 whatever the challenge says of it; the fresh read hides it.
        expect(screen.queryByRole('button', { name: /^Photo 00000001:/ })).not.toBeNull();
        await act(async () =>
            fresh.resolve(listing([photo(1, { allowed: false, message: 'Already used' }), photo(2)])),
        );
        await waitFor(() => expect(screen.queryByRole('button', { name: /^Photo 00000001:/ })).toBeNull());
        expect(screen.getByText("Hidden: 1 photo(s) GuruShots won't take in this challenge.")).toBeTruthy();
        expect(screen.queryByText(/as last loaded/)).toBeNull();
        expect(tile(2).getAttribute('aria-disabled')).toBe('false');
        fireEvent.click(tile(2));
        expect(submitButton().hasAttribute('disabled')).toBe(false);
    });

    test('a re-check that failed keeps picking held and says so; Refresh tries again and a listing that arrives unlocks it', async () => {
        getLibrary()
            .mockResolvedValueOnce(listing([photo(1)]))
            .mockResolvedValueOnce(failure);
        setupLoaded();
        const line = await screen.findByText(
            "Couldn't check which of these photos this challenge accepts, so picking is held. Press Refresh.",
        );
        expect(tile(1).textContent).toContain(LOCKED);
        expect(submitButton().hasAttribute('disabled')).toBe(true);
        getLibrary().mockResolvedValueOnce(listing([photo(1)]));
        fireEvent.click(refreshButton());
        await waitFor(() => expect(line.isConnected).toBe(false));
        expect(tile(1).getAttribute('aria-disabled')).toBe('false');
    });

    test('a failed Refresh locks a listing that was fresh until another Refresh answers', async () => {
        setupLoaded();
        await opened();
        getLibrary().mockResolvedValueOnce(failure);
        fireEvent.click(refreshButton());
        await waitFor(() => expect(tile(1).textContent).toContain(LOCKED));
        getLibrary().mockResolvedValueOnce(listing([photo(1)]));
        fireEvent.click(refreshButton());
        await waitFor(() => expect(tile(1).getAttribute('aria-disabled')).toBe('false'));
    });

    test('Refresh is held while a submit is in flight', async () => {
        const { update } = setupLoaded();
        await opened();
        expect(refreshButton().hasAttribute('disabled')).toBe(false);
        update({ submitting: true });
        expect(refreshButton().hasAttribute('disabled')).toBe(true);
    });

    test('after a Refresh the pick is checked against what it brought: a photo that is no longer allowed, or has won, leaves it', async () => {
        setupLoaded();
        await opened();
        fireEvent.click(tile(1));
        fireEvent.click(tile(2));
        fireEvent.click(tile(3));
        getLibrary().mockResolvedValueOnce(
            listing([photo(1), photo(2, { allowed: false }), photo(4)], { wonIds: [idOf(3)], wonCount: 1 }),
        );
        fireEvent.click(refreshButton());
        await waitFor(() => expect(submitButton().textContent).toBe('Submit 1'));
        expect(tile(1).getAttribute('aria-pressed')).toBe('true');
        expect(screen.queryByRole('button', { name: new RegExp(`^Photo ${shortOf(2)}:`) })).toBeNull();
    });

    test('a check waiting for a Refresh waits for the fresh listing: a preview in between prunes nothing', async () => {
        setupLoaded();
        await opened();
        fireEvent.click(tile(1));
        fireEvent.click(tile(2));
        // The Refresh is replaced by a new search before it answers; the search comes back as a preview.
        getLibrary().mockReturnValueOnce(new Promise(() => undefined));
        fireEvent.click(refreshButton());
        const fresh = deferred<Listing>();
        getLibrary()
            .mockResolvedValueOnce(listing([photo(1), photo(2), photo(3)]))
            .mockReturnValueOnce(fresh.promise);
        fireEvent.click(screen.getByRole('button', { name: 'Search' }));
        await waitFor(() => expect(screen.getByText(/as last loaded/)).toBeTruthy());
        await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
        expect(tile(2).getAttribute('aria-pressed')).toBe('true');
        await act(async () => fresh.resolve(listing([photo(1), photo(2, { allowed: false }), photo(3)])));
        await waitFor(() =>
            expect(screen.queryByRole('button', { name: new RegExp(`^Photo ${shortOf(2)}:`) })).toBeNull(),
        );
        expect(tile(1).getAttribute('aria-pressed')).toBe('true');
    });
});

describe('the check of the pick against a listing', () => {
    const deferred = <T,>() => {
        let resolve!: (value: T) => void;
        const promise = new Promise<T>((r) => (resolve = r));
        return { promise, resolve };
    };
    const failure = invalid<Awaited<ReturnType<WindowApi['getLibraryPhotos']>>>({
        success: false,
        error: 'Failed to read your photo library',
    });
    const refreshButton = () => screen.getByRole('button', { name: 'Refresh photos' });

    test('a check waiting for a Refresh is not spent on a preview whose re-check failed: it runs on the fresh listing a tag search brings', async () => {
        setupLoaded();
        await opened();
        fireEvent.click(tile(1));
        fireEvent.click(tile(2));
        // A Refresh that never answers leaves the check waiting.
        getLibrary().mockReturnValueOnce(new Promise(() => undefined));
        fireEvent.click(refreshButton());
        // An empty search comes back as a preview, and its background read fails.
        getLibrary()
            .mockResolvedValueOnce(listing([photo(1), photo(2), photo(3)]))
            .mockResolvedValueOnce(failure);
        fireEvent.click(screen.getByRole('button', { name: 'Search' }));
        await screen.findByText(
            "Couldn't check which of these photos this challenge accepts, so picking is held. Press Refresh.",
        );
        await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
        expect(tile(2).getAttribute('aria-pressed')).toBe('true');
        // A tag search brings a fresh listing that does not allow photo 2.
        getLibrary().mockResolvedValueOnce(listing([photo(1), photo(2, { allowed: false }), photo(3)]));
        fireEvent.change(screen.getByLabelText('Search your photos by tag'), { target: { value: 'tag' } });
        fireEvent.click(screen.getByRole('button', { name: 'Search' }));
        await waitFor(() =>
            expect(screen.queryByRole('button', { name: new RegExp(`^Photo ${shortOf(2)}:`) })).toBeNull(),
        );
        expect(tile(1).getAttribute('aria-pressed')).toBe('true');
    });

    test('a Refresh that lands while a submit is in flight leaves the pick alone, and the check runs once the submit has ended', async () => {
        const { update } = setupLoaded();
        await opened();
        fireEvent.click(tile(1));
        fireEvent.click(tile(2));
        const reread = deferred<Listing>();
        getLibrary().mockReturnValueOnce(reread.promise);
        fireEvent.click(refreshButton());
        update({ submitting: true });
        await act(async () => reread.resolve(listing([photo(1), photo(2, { allowed: false }), photo(3)])));
        await waitFor(() => expect(refreshButton().getAttribute('aria-busy')).toBe('false'));
        await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
        expect(tile(2).getAttribute('aria-pressed')).toBe('true');
        expect(submitButton().textContent).toBe('Submit 2');
        update({ submitting: false });
        await waitFor(() =>
            expect(screen.queryByRole('button', { name: new RegExp(`^Photo ${shortOf(2)}:`) })).toBeNull(),
        );
    });
});

describe('failure text', () => {
    test('shows the translated error inline as an alert', async () => {
        setupLoaded({ error: 'The photos were not submitted. Pick other photos.' });
        await opened();
        expect(screen.getByRole('alert').textContent).toBe('The photos were not submitted. Pick other photos.');
    });
});

describe('the cap changing while open', () => {
    test('a cap below the picks says so and holds Submit until enough are taken back', async () => {
        const { update } = setupLoaded({ max: 3 });
        await opened();
        fireEvent.click(tile(1));
        fireEvent.click(tile(2));
        fireEvent.click(tile(3));
        update({ max: 2 });
        expect(countLine().textContent).toBe('Picked: 3, open slots: 2. Remove some to submit.');
        expect(submitButton().hasAttribute('disabled')).toBe(true);
        // Picked tiles stay removable; unpicked ones are held.
        expect(tile(4).getAttribute('aria-disabled')).toBe('true');
        fireEvent.click(tile(3));
        expect(submitButton().hasAttribute('disabled')).toBe(false);
        expect(submitButton().textContent).toBe('Submit 2');
    });

    test('a cap of one under several picks: tapping an unpicked photo leaves just that photo, ready to submit', async () => {
        const { update, props } = setupLoaded({ max: 3 });
        await opened();
        fireEvent.click(tile(1));
        fireEvent.click(tile(2));
        update({ max: 1 });
        expect(submitButton().hasAttribute('disabled')).toBe(true);
        fireEvent.click(tile(3));
        expect(tile(3).getAttribute('aria-pressed')).toBe('true');
        expect(tile(1).getAttribute('aria-pressed')).toBe('false');
        expect(tile(2).getAttribute('aria-pressed')).toBe('false');
        expect(submitButton().hasAttribute('disabled')).toBe(false);
        expect(submitButton().textContent).toBe('Submit 1');
        fireEvent.click(submitButton());
        await waitFor(() => expect(props.onSubmit).toHaveBeenCalledWith([idOf(3)]));
    });

    test('no open slots left: says so with Close only, whatever was picked', async () => {
        const onClose = jest.fn();
        const { update } = setupLoaded({ max: 2, onClose });
        await opened();
        fireEvent.click(tile(1));
        update({ max: 0 });
        expect(screen.getByText(/^No open slots left/)).toBeTruthy();
        expect(screen.queryByRole('button', { name: /^Submit/ })).toBeNull();
        expect(screen.queryByRole('button', { name: /^Photo / })).toBeNull();
        expect(screen.queryByLabelText('Search your photos by tag')).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: 'Close' }));
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    test('with no open slots no failure alert is shown: its next step would contradict "Close this window"', async () => {
        const { update } = setupLoaded({ max: 1 });
        await opened();
        update({ max: 0, error: 'The photos may have been submitted.' });
        expect(screen.queryByRole('alert')).toBeNull();
        expect(screen.getByText(/^No open slots left/)).toBeTruthy();
    });

    test('with no open slots a submit in flight keeps Close held', async () => {
        const { update } = setupLoaded({ max: 1 });
        await opened();
        update({ max: 0, submitting: true });
        expect(screen.getAllByRole('button', { name: 'Close' }).every((b) => b.hasAttribute('disabled'))).toBe(true);
    });
});

describe('closing', () => {
    test('Cancel and Escape close it while idle', async () => {
        const onClose = jest.fn();
        setupLoaded({ onClose });
        await opened();
        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
        expect(onClose).toHaveBeenCalledTimes(1);
        fireEvent.keyDown(document, { key: 'Escape' });
        expect(onClose).toHaveBeenCalledTimes(2);
    });

    test('while a submit is in flight nothing closes it: no Cancel, no Escape, no ✕, and Submit shows busy', async () => {
        const onClose = jest.fn();
        const { update } = setupLoaded({ onClose });
        await opened();
        update({ submitting: true });
        expect(screen.getByRole('button', { name: 'Cancel' }).hasAttribute('disabled')).toBe(true);
        expect(screen.queryByRole('button', { name: 'Close modal' })).toBeNull();
        fireEvent.keyDown(document, { key: 'Escape' });
        fireEvent.click(document.querySelector('.modal-backdrop')!);
        expect(onClose).not.toHaveBeenCalled();
        const submit = screen.getByRole('button', { name: /Submit/ });
        expect(submit.getAttribute('aria-busy')).toBe('true');
        expect(submit.hasAttribute('disabled')).toBe(true);
    });

    test('the tiles are locked and say why while a submit is in flight, instead of ignoring taps', async () => {
        const { update } = setup();
        await loadedAll();
        expect(tile(1).getAttribute('aria-disabled')).toBe('false');
        update({ submitting: true });
        expect(tile(1).getAttribute('aria-disabled')).toBe('true');
        expect(tile(1).textContent).toContain('Locked while your pick is being submitted.');
        fireEvent.click(tile(1));
        expect(tile(1).getAttribute('aria-pressed')).toBe('false');
        update({ submitting: false });
        expect(tile(1).getAttribute('aria-disabled')).toBe('false');
    });
});

describe('the listing states', () => {
    test('a failed read shows the error with Retry, which reads again', async () => {
        getLibrary().mockResolvedValueOnce(invalid({ success: false, error: 'Failed to read your photo library' }));
        setupLoaded();
        await screen.findByRole('alert');
        fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
        await opened();
        expect(getLibrary()).toHaveBeenCalledTimes(2);
    });

    test('a superseded answer offers Retry too', async () => {
        getLibrary().mockResolvedValueOnce(invalid({ success: false, error: 'superseded' }));
        setupLoaded();
        await screen.findByRole('button', { name: 'Retry' });
    });
});

describe('texts, notice and blocked photos (the swap picker)', () => {
    // Photo 1 is the blocked one, so the fresh read is told by photo 2.
    const openedPast1 = async () => {
        await screen.findByRole('button', { name: /^Photo 00000001:/ });
        await waitFor(() => expect(tile(2).textContent).toContain('Can be entered'));
    };
    const swapTexts = {
        title: 'app.swapPickTitle',
        help: 'app.swapPickHelp',
        count: 'app.swapPickCount',
        overCap: 'app.pickOverCap',
        submit: 'app.swapPickSubmit',
        submitCount: 'app.swapPickSubmit',
        full: 'app.pickFull',
        noSlots: 'app.pickNoSlots',
        autoHelp: 'app.swapPickAutoHelp',
        autoRunning: 'app.swapPickAutoRunning',
        idleWithPicks: 'app.swapPickIdleWithPicks',
    };

    test('texts replace the title, help, count and both submit labels', async () => {
        setupLoaded({ max: 1, texts: swapTexts });
        await opened();
        expect(screen.getByText('Choose the photo to swap in')).toBeTruthy();
        expect(screen.getByText(/^The photo you pick replaces the current one\./)).toBeTruthy();
        expect(countLine().textContent).toBe('Picked: 0/1');
        const useButton = () => screen.getByRole('button', { name: /^Use this photo/ });
        expect(useButton().textContent).toBe('Use this photo');
        fireEvent.click(tile(1));
        expect(useButton().textContent).toBe('Use this photo');
        expect(useButton().hasAttribute('disabled')).toBe(false);
    });

    test('texts name the no-slots line too', () => {
        setup({ max: 0, texts: { ...swapTexts, noSlots: 'app.pickFull' } });
        expect(screen.getByRole('status').textContent).toBe('All open slots picked');
    });

    test('a notice shows as an info line above the body, and is absent by default', async () => {
        const { unmount } = setupLoaded({ notice: 'No different photo is available.' });
        await opened();
        const notice = screen.getByText('No different photo is available.');
        expect(notice.closest('[role="status"]')?.className).toContain('alert-info');
        unmount();
        setupLoaded();
        await opened();
        expect(document.querySelector('.alert-info')).toBeNull();
    });

    test('blocked photos show their reason and cannot be picked', async () => {
        const { props } = setupLoaded({
            max: 1,
            blocked: { ids: new Set([idOf(1)]), reasonKey: 'app.swapPickBlocked' },
        });
        await openedPast1();
        expect(tile(1).textContent).toContain('Already in this challenge');
        expect(tile(1).getAttribute('aria-disabled')).toBe('true');
        fireEvent.click(tile(1));
        expect(tile(1).getAttribute('aria-pressed')).toBe('false');
        expect(submitButton().hasAttribute('disabled')).toBe(true);
        expect(tile(2).getAttribute('aria-disabled')).toBe('false');
        fireEvent.click(tile(2));
        fireEvent.click(submitButton());
        await waitFor(() => expect(props.onSubmit).toHaveBeenCalledWith([idOf(2)]));
    });

    test('a blocked photo is blocked even when the listing cannot judge eligibility', async () => {
        getLibrary().mockResolvedValue(listing([photo(1), photo(2)], { allowedKnown: false }));
        setupLoaded({ max: 1, blocked: { ids: new Set([idOf(1)]), reasonKey: 'app.swapPickBlocked' } });
        await screen.findByRole('button', { name: /^Photo 00000001:/ });
        await waitFor(() => expect(tile(2).getAttribute('aria-disabled')).toBe('false'));
        expect(tile(1).textContent).toContain('Already in this challenge');
        expect(tile(1).getAttribute('aria-disabled')).toBe('true');
    });
});

describe('Auto suggestions', () => {
    type Suggestion = Awaited<ReturnType<WindowApi['suggestPhotos']>>;
    type SuggestionOk = Extract<Suggestion, { success: true }>;
    const suggestion = (photos: LibraryPhoto[], over: Partial<SuggestionOk> = {}): SuggestionOk => ({
        success: true,
        memberId: MEMBER,
        photos,
        statsLimited: false,
        ...over,
    });
    const failure = (error: string) => invalid<Suggestion>({ success: false, error });
    const deferred = <T,>() => {
        let resolve!: (value: T) => void;
        const promise = new Promise<T>((r) => (resolve = r));
        return { promise, resolve };
    };
    const suggestPhotos = () => jest.mocked(window.api.suggestPhotos);
    const autoButton = () => screen.getByRole('button', { name: 'Auto' });
    const strip = () => screen.getByRole('region', { name: 'Suggestions' });
    const stripTile = (n: number) => within(strip()).getByRole('button', { name: new RegExp(`^Photo ${shortOf(n)}:`) });
    // The tile in the listing's grid (the strip's tile of the same photo has the same name).
    const gridTile = (n: number) =>
        screen
            .getAllByRole('button', { name: new RegExp(`^Photo ${shortOf(n)}:`) })
            .find((tileEl) => !strip().contains(tileEl)) as HTMLElement;
    const addButton = () => within(strip()).getByRole('button', { name: /^(Add suggestions|No free slots)$/ });
    const stripOrder = () =>
        within(strip())
            .getAllByRole('button', { name: /^Photo/ })
            .map((el) => /^Photo (\d{8}):/.exec(el.getAttribute('aria-label') ?? '')?.[1]);
    const press = async (photos = [photo(3), photo(1), photo(2)], over: Partial<SuggestionOk> = {}) => {
        suggestPhotos().mockResolvedValueOnce(suggestion(photos, over));
        fireEvent.click(autoButton());
        await screen.findByRole('region', { name: 'Suggestions' });
    };

    beforeEach(() => {
        suggestPhotos().mockResolvedValue(suggestion([photo(1)]));
    });

    test('the help line is shown always, and the texts can name another one', async () => {
        const { unmount } = setup();
        await loadedAll();
        expect(
            screen.getByText(
                'Auto ranks your photos by your auto-submit rules, and by the local image check where your build has it. Nothing is submitted.',
            ),
        ).toBeTruthy();
        expect(autoButton().getAttribute('aria-disabled')).toBe('false');
        unmount();
        setup({ max: 1, texts: { ...PICK_TEXTS, autoHelp: 'app.swapPickAutoHelp' } });
        expect(
            screen.getByText(
                'Auto ranks your photos by your auto-submit rules, and by the local image check where your build has it. Nothing is swapped.',
            ),
        ).toBeTruthy();
    });

    test('while it runs Auto is aria-disabled and busy, keeps focus and ignores a press, and a status line says nothing is submitted', async () => {
        const answer = deferred<Suggestion>();
        suggestPhotos().mockReturnValueOnce(answer.promise);
        setup();
        await loadedAll();
        autoButton().focus();
        fireEvent.click(autoButton());
        await waitFor(() => expect(autoButton().getAttribute('aria-busy')).toBe('true'));
        expect(autoButton().getAttribute('aria-disabled')).toBe('true');
        // Not `disabled`: that would drop the keyboard focus to <body>.
        expect(autoButton().hasAttribute('disabled')).toBe(false);
        expect(document.activeElement).toBe(autoButton());
        expect(screen.getByText('Ranking your photos… this can take a minute. Nothing is submitted.')).toBeTruthy();
        expect(suggestPhotos()).toHaveBeenCalledWith(7, 'submit');
        fireEvent.click(autoButton());
        expect(suggestPhotos()).toHaveBeenCalledTimes(1);
        await act(async () => answer.resolve(suggestion([photo(2)])));
        expect(autoButton().getAttribute('aria-disabled')).toBe('false');
        expect(screen.queryByText(/Ranking your photos/)).toBeNull();
    });

    test('one status region is always mounted: empty at first, the running text, then the count read out only', async () => {
        const answer = deferred<Suggestion>();
        suggestPhotos().mockReturnValueOnce(answer.promise);
        setup();
        await loadedAll();
        const region = screen.getAllByRole('status').find((el) => el.getAttribute('aria-live') === 'polite');
        expect(region?.textContent).toBe('');
        fireEvent.click(autoButton());
        await waitFor(() =>
            expect(region?.textContent).toBe('Ranking your photos… this can take a minute. Nothing is submitted.'),
        );
        await act(async () => answer.resolve(suggestion([photo(2), photo(3)])));
        await screen.findByRole('region', { name: 'Suggestions' });
        // The same element, now holding the count; the strip shows the count as plain text.
        expect(region?.isConnected).toBe(true);
        expect(region?.textContent).toBe('Suggestions: 2');
        expect(region?.className).toContain('sr-only');
        // The strip's own count is hidden from assistive tech: the region above already announces it.
        expect(within(strip()).getByText('Suggestions: 2').getAttribute('aria-hidden')).toBe('true');
        fireEvent.click(screen.getByRole('button', { name: 'Refresh photos' }));
        await waitFor(() => expect(region?.textContent).toBe(''));
    });

    test('the running text can be another one', async () => {
        const answer = deferred<Suggestion>();
        suggestPhotos().mockReturnValueOnce(answer.promise);
        setup({ max: 1, texts: { ...PICK_TEXTS, autoRunning: 'app.swapPickAutoRunning' } });
        fireEvent.click(autoButton());
        expect(await screen.findByText('Ranking your photos… this can take a minute. Nothing is spent.')).toBeTruthy();
        await act(async () => answer.resolve(suggestion([photo(1)])));
    });

    test('the strip tiles are locked while a submit is in flight', async () => {
        const { update } = setup();
        await loadedAll();
        await press();
        update({ submitting: true });
        expect(stripTile(1).getAttribute('aria-disabled')).toBe('true');
        expect(stripTile(1).textContent).toContain('Locked while your pick is being submitted.');
    });

    test('the strip lists the suggestions in the returned order with fixed rank badges, and keeps it after a tap', async () => {
        setup();
        await loadedAll();
        await press();
        expect(stripOrder()).toEqual([shortOf(3), shortOf(1), shortOf(2)]);
        expect(within(strip()).getByRole('img', { name: 'Suggestion #1' }).textContent).toBe('#1');
        expect(within(strip()).getByRole('img', { name: 'Suggestion #3' })).toBeTruthy();
        expect(stripTile(1).getAttribute('aria-label')).toMatch(/Suggestion #2\.$/);
        expect(within(strip()).getByText('Suggestions: 3')).toBeTruthy();
        fireEvent.click(stripTile(1));
        expect(stripOrder()).toEqual([shortOf(3), shortOf(1), shortOf(2)]);
        expect(stripTile(1).getAttribute('aria-pressed')).toBe('true');
        expect(gridTile(1).getAttribute('aria-pressed')).toBe('true');
        expect(countLine().textContent).toBe('Picked: 1/3 open slots');
        fireEvent.click(stripTile(1));
        expect(stripTile(1).getAttribute('aria-pressed')).toBe('false');
        // The strip carries the reply's member for the thumbnails, and the grid's tiles carry no rank.
        expect(stripTile(3).querySelector('img')?.getAttribute('src')).toContain(MEMBER);
        expect(gridTile(1).querySelector('[role="img"]')).toBeNull();
    });

    test('taps on the strip are ignored while submitting, and the strip is held while the app checks', async () => {
        const { update } = setup();
        await loadedAll();
        await press();
        update({ submitting: true });
        fireEvent.click(stripTile(2));
        expect(stripTile(2).getAttribute('aria-pressed')).toBe('false');
        expect(addButton().hasAttribute('disabled')).toBe(true);
        update({ submitting: false });
        fireEvent.click(stripTile(2));
        expect(stripTile(2).getAttribute('aria-pressed')).toBe('true');
    });

    test('a picked suggestion the listing does not return still shows as a tile, also after the strip clears', async () => {
        setup();
        await loadedAll();
        await press([photo(9, { labels: ['sunset'] }), photo(1)]);
        expect(screen.getAllByRole('button', { name: /^Photo 00000009:/ })).toHaveLength(1);
        fireEvent.click(stripTile(9));
        const inGrid = () => screen.getAllByRole('button', { name: /^Photo 00000009:/ });
        expect(inGrid()).toHaveLength(2);
        expect(screen.queryByText(/isn't in the photos listed|Not found in the photos listed/)).toBeNull();
        getLibrary().mockResolvedValueOnce(listing([photo(1), photo(2), photo(3), photo(4)]));
        fireEvent.click(screen.getByRole('button', { name: 'Refresh photos' }));
        await waitFor(() => expect(screen.queryByRole('region', { name: 'Suggestions' })).toBeNull());
        // Still picked and shown as the photo itself, not as a missing or pending tile.
        await waitFor(() => expect(inGrid()).toHaveLength(1));
        expect(inGrid()[0].getAttribute('aria-pressed')).toBe('true');
        expect(inGrid()[0].textContent).toContain('sunset');
        expect(submitButton().textContent).toBe('Submit 1');
    });

    test('a picked suggestion shows from the record while the listing is a preview', async () => {
        const fresh = deferred<Listing>();
        getLibrary()
            .mockResolvedValueOnce(listing([photo(1), photo(2)]))
            .mockReturnValueOnce(fresh.promise);
        setup();
        loadAll();
        await screen.findByRole('button', { name: /^Photo 00000001:/ });
        await press([photo(9)]);
        // Picking waits for the fresh read: the strip is held with the grid.
        fireEvent.click(stripTile(9));
        expect(stripTile(9).getAttribute('aria-pressed')).toBe('false');
        expect(addButton().hasAttribute('disabled')).toBe(true);
        await act(async () => fresh.resolve(listing([photo(1), photo(2)])));
        await waitFor(() => expect(stripTile(9).getAttribute('aria-disabled')).toBe('false'));
        fireEvent.click(stripTile(9));
        expect(stripTile(9).getAttribute('aria-pressed')).toBe('true');
    });

    test('Add suggestions fills only the free slots with the top suggestions not picked, and keeps hand picks', async () => {
        const { props } = setup({ max: 3 });
        await loadedAll();
        await press([photo(3), photo(1), photo(2), photo(4)]);
        fireEvent.click(gridTile(4));
        expect(addButton().textContent).toBe('Add suggestions');
        fireEvent.click(addButton());
        // 4 was picked by hand; two free slots take #1 and #2 of the suggestions.
        expect(countLine().textContent).toBe('Picked: 3/3 open slots');
        expect(stripTile(3).getAttribute('aria-pressed')).toBe('true');
        expect(stripTile(1).getAttribute('aria-pressed')).toBe('true');
        expect(stripTile(2).getAttribute('aria-pressed')).toBe('false');
        expect(stripTile(4).getAttribute('aria-pressed')).toBe('true');
        expect(addButton().textContent).toBe('No free slots');
        expect(addButton().hasAttribute('disabled')).toBe(true);
        expect(stripTile(2).textContent).toContain('All open slots picked');
        fireEvent.click(submitButton());
        await waitFor(() => expect(props.onSubmit).toHaveBeenCalledWith([idOf(4), idOf(3), idOf(1)]));
    });

    test('Add suggestions is disabled once every suggestion is picked, and enabled again when one is un-picked', async () => {
        setup({ max: 3 });
        await loadedAll();
        await press([photo(1), photo(2)]);
        expect(addButton().hasAttribute('disabled')).toBe(false);
        fireEvent.click(addButton());
        expect(countLine().textContent).toBe('Picked: 2/3 open slots');
        // A free slot is left, but nothing is left to add.
        expect(addButton().textContent).toBe('Add suggestions');
        expect(addButton().hasAttribute('disabled')).toBe(true);
        fireEvent.click(stripTile(2));
        expect(addButton().hasAttribute('disabled')).toBe(false);
    });

    test('with one open slot Add suggestions picks the best suggestion, swapping a hand pick, and is never "full"', async () => {
        setup({ max: 1 });
        await loadedAll();
        await press([photo(3), photo(1)]);
        fireEvent.click(gridTile(2));
        expect(addButton().textContent).toBe('Add suggestions');
        expect(addButton().hasAttribute('disabled')).toBe(false);
        fireEvent.click(addButton());
        expect(stripTile(3).getAttribute('aria-pressed')).toBe('true');
        expect(gridTile(2).getAttribute('aria-pressed')).toBe('false');
        expect(countLine().textContent).toBe('Picked: 1/1 open slots');
        // With one slot it swaps in #1, so it has nothing to do only when #1 is the pick.
        expect(addButton().hasAttribute('disabled')).toBe(true);
        fireEvent.click(stripTile(1));
        expect(addButton().hasAttribute('disabled')).toBe(false);
    });

    test('Submit stays held while the app checks, with suggestions picked', async () => {
        getLibrary().mockResolvedValue(listing([photo(1), photo(2)], { preview: true }));
        setup();
        loadAll();
        await screen.findByRole('button', { name: /^Photo 00000001:/ });
        await press([photo(1)]);
        fireEvent.click(addButton());
        expect(addButton().hasAttribute('disabled')).toBe(true);
        expect(submitButton().hasAttribute('disabled')).toBe(true);
    });

    test('a Refresh clears the strip and drops an answer still on its way', async () => {
        const answer = deferred<Suggestion>();
        suggestPhotos().mockReturnValueOnce(answer.promise);
        setup();
        await loadedAll();
        fireEvent.click(autoButton());
        await waitFor(() => expect(autoButton().getAttribute('aria-disabled')).toBe('true'));
        fireEvent.click(screen.getByRole('button', { name: 'Refresh photos' }));
        await act(async () => answer.resolve(suggestion([photo(2)])));
        expect(screen.queryByRole('region', { name: 'Suggestions' })).toBeNull();
        await press();
        fireEvent.click(screen.getByRole('button', { name: 'Refresh photos' }));
        await waitFor(() => expect(screen.queryByRole('region', { name: 'Suggestions' })).toBeNull());
    });

    test('a Refresh also drops the failure of a ranking that is answered after it', async () => {
        const answer = deferred<Suggestion>();
        suggestPhotos().mockReturnValueOnce(answer.promise);
        setup();
        await loadedAll();
        fireEvent.click(autoButton());
        await waitFor(() => expect(autoButton().getAttribute('aria-disabled')).toBe('true'));
        fireEvent.click(screen.getByRole('button', { name: 'Refresh photos' }));
        await act(async () => answer.resolve(failure('no-match')));
        expect(screen.queryByRole('alert')).toBeNull();
    });

    test('a failed press after a success leaves no strip and shows the alert, keeping the picked suggestions’ tiles', async () => {
        setup();
        await loadedAll();
        await press([photo(9, { labels: ['sunset'] }), photo(1)]);
        fireEvent.click(stripTile(9));
        suggestPhotos().mockResolvedValueOnce(failure('no-match'));
        fireEvent.click(autoButton());
        const alert = await screen.findByRole('alert');
        expect(alert.textContent).toMatch(/^Nothing to suggest\. No photo matches your Must Include Tags/);
        expect(screen.queryByRole('region', { name: 'Suggestions' })).toBeNull();
        // The picked suggestion keeps its tile in the grid.
        const kept = screen.getAllByRole('button', { name: /^Photo 00000009:/ });
        expect(kept).toHaveLength(1);
        expect(kept[0].getAttribute('aria-pressed')).toBe('true');
    });

    test('after a refreshed submit a picked suggestion the re-read listing does not return stays picked', async () => {
        const onSubmit = jest.fn<Promise<PickOutcome>, [string[]]>().mockResolvedValue('refreshed');
        setup({ onSubmit });
        await loadedAll();
        await press([photo(9), photo(1)]);
        fireEvent.click(stripTile(9));
        fireEvent.click(stripTile(1));
        expect(countLine().textContent).toBe('Picked: 2/3 open slots');
        // The re-read does not return 9 (an active search, say): with no record saying it is blocked, it stays.
        getLibrary().mockResolvedValue(listing([photo(1), photo(2), photo(3), photo(4)]));
        fireEvent.click(submitButton());
        await waitFor(() => expect(screen.queryByRole('region', { name: 'Suggestions' })).toBeNull());
        // Photo 4 only exists in the re-read, so the pick is checked against the listing it brought.
        await screen.findByRole('button', { name: /^Photo 00000004:/ });
        expect(countLine().textContent).toBe('Picked: 2/3 open slots');
        expect(tile(1).getAttribute('aria-pressed')).toBe('true');
        expect(screen.getByRole('button', { name: /^Photo 00000009:/ }).getAttribute('aria-pressed')).toBe('true');
    });

    test('a submit that comes back refreshed clears the strip, and one that failed leaves it', async () => {
        const onSubmit = jest.fn<Promise<PickOutcome>, [string[]]>().mockResolvedValue('failed');
        setup({ onSubmit });
        await loadedAll();
        await press();
        fireEvent.click(stripTile(1));
        fireEvent.click(submitButton());
        await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
        expect(screen.getByRole('region', { name: 'Suggestions' })).toBeTruthy();
        onSubmit.mockResolvedValue('refreshed');
        fireEvent.click(submitButton());
        await waitFor(() => expect(screen.queryByRole('region', { name: 'Suggestions' })).toBeNull());
    });

    test('an answer that arrives after the modal unmounted is dropped', async () => {
        const answer = deferred<Suggestion>();
        suggestPhotos().mockReturnValueOnce(answer.promise);
        const { unmount } = setup();
        await loadedAll();
        fireEvent.click(autoButton());
        await waitFor(() => expect(autoButton().getAttribute('aria-disabled')).toBe('true'));
        unmount();
        await act(async () => answer.resolve(suggestion([photo(2)])));
        expect(document.querySelector('[role="dialog"]')).toBeNull();
    });

    test('when popularity stats were limited a line says the ranking leans on tags and the image check', async () => {
        setup();
        await loadedAll();
        await press([photo(1)], { statsLimited: true });
        expect(
            within(strip()).getByText(
                "Popularity stats couldn't all be read (the lookups kept failing), so this ranking leans on tags and the image check.",
            ),
        ).toBeTruthy();
    });

    test('no stats line when they were all read', async () => {
        setup();
        await loadedAll();
        await press();
        expect(within(strip()).queryByText(/Popularity stats/)).toBeNull();
    });

    test.each([
        [
            'no-chosen-entered',
            /^Nothing to suggest\. Submit Only Chosen Photos is on and every chosen photo is already entered/,
        ],
        ['no-chosen-unusable', /^Nothing to suggest\. Submit Only Chosen Photos is on and none of your chosen photos/],
        [
            'no-match',
            /^Nothing to suggest\. No photo matches your Must Include Tags\. Loosen the tags, or pick by hand\.$/,
        ],
        ['no-eligible', /^Nothing to suggest\. Your library has no photo this challenge accepts right now/],
        ['suggest-busy', /^The photos were not ranked\. Another ranking is still running/],
        [
            'account-changed',
            /^The photos were not ranked\. You switched accounts while it ran\. Close this dialog and open it again\.$/,
        ],
        ['challenge-ended', /^The photos were not ranked\. This challenge has ended or could not be read/],
        ['fetch-failed', /^The photos were not ranked\. GuruShots did not answer/],
        ['suggest-failed', /^The photos were not ranked\. GuruShots did not answer/],
        ['invalid-args', /^The action could not run/],
        ['something raw', /^The photos were not ranked\. GuruShots did not answer/],
    ])('the failure %j is an inline alert in words, never the code', async (code, text) => {
        suggestPhotos().mockResolvedValueOnce(failure(code));
        setup();
        await loadedAll();
        fireEvent.click(autoButton());
        const alert = await screen.findByRole('alert');
        expect(alert.className).toContain('alert-error');
        expect(alert.textContent).toMatch(text);
        expect(alert.textContent).not.toContain(code === 'something raw' ? 'raw' : code);
        expect(screen.queryByRole('region', { name: 'Suggestions' })).toBeNull();
        // Pressing Auto again clears the alert while it runs.
        suggestPhotos().mockReturnValueOnce(new Promise(() => undefined));
        fireEvent.click(autoButton());
        await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    });

    test('a call that throws is the generic ranking failure', async () => {
        suggestPhotos().mockRejectedValueOnce(new Error('ECONNRESET'));
        setup();
        await loadedAll();
        fireEvent.click(autoButton());
        const alert = await screen.findByRole('alert');
        expect(alert.textContent).toMatch(/^The photos were not ranked\. GuruShots did not answer/);
        expect(alert.textContent).not.toContain('ECONNRESET');
    });
});

describe('Pick… loads photos on demand', () => {
    type Answer = Awaited<ReturnType<WindowApi['getLibraryPhotos']>>;
    type Suggestion = Awaited<ReturnType<WindowApi['suggestPhotos']>>;
    type SuggestionOk = Extract<Suggestion, { success: true }>;
    const suggestion = (photos: LibraryPhoto[], over: Partial<SuggestionOk> = {}): SuggestionOk => ({
        success: true,
        memberId: MEMBER,
        photos,
        statsLimited: false,
        ...over,
    });
    const deferred = <T,>() => {
        let resolve!: (value: T) => void;
        const promise = new Promise<T>((r) => (resolve = r));
        return { promise, resolve };
    };
    const failed = invalid<Answer>({ success: false, error: 'Failed to read your photo library' });
    const suggestPhotos = () => jest.mocked(window.api.suggestPhotos);
    const loadAllButton = () => screen.getByRole('button', { name: 'Load all photos' });
    const autoButton = () => screen.getByRole('button', { name: 'Auto' });
    const searchBox = () => screen.getByLabelText<HTMLInputElement>('Search your photos by tag');
    const idleLine = () => screen.queryByText(/^Photos are not loaded yet/);
    const auto = async (photos: LibraryPhoto[], over: Partial<SuggestionOk> = {}) => {
        suggestPhotos().mockResolvedValueOnce(suggestion(photos, over));
        fireEvent.click(autoButton());
        await screen.findByRole('region', { name: 'Suggestions' });
    };
    const strip = () => screen.queryByRole('region', { name: 'Suggestions' });
    // The tile in the grid: the strip's tile of the same photo has the same name.
    const idleTile = (n: number) => {
        const found = screen
            .getAllByRole('button', { name: new RegExp(`^Photo ${shortOf(n)}:`) })
            .find((el) => !strip()?.contains(el));
        expect(found).toBeDefined();
        return found!;
    };
    const pickFromStrip = (n: number) =>
        fireEvent.click(
            within(screen.getByRole('region', { name: 'Suggestions' })).getByRole('button', {
                name: new RegExp(`^Photo ${shortOf(n)}:`),
            }),
        );

    test('opens with nothing read: an idle line and Load all, Search and Auto offered', () => {
        setup();
        expect(getLibrary()).not.toHaveBeenCalled();
        expect(idleLine()?.getAttribute('role')).toBe('status');
        expect(loadAllButton().getAttribute('aria-disabled')).toBe('false');
        expect(idleLine()?.textContent).toBe('Photos are not loaded yet. Load them all, search, or press Auto.');
        expect(screen.getByRole('button', { name: 'Search' })).toBeTruthy();
        expect(autoButton()).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Refresh photos' })).toBeNull();
    });

    test('Load all reads the library and keeps the focus on its button', async () => {
        setup();
        loadAllButton().focus();
        loadAll();
        await opened();
        expect(getLibrary().mock.calls).toEqual([
            [7, undefined, 'cached', 'submit'],
            [7, undefined, 'fresh', 'submit'],
        ]);
        expect(idleLine()).toBeNull();
        expect(document.activeElement).toBe(loadAllButton());
        expect(loadAllButton().getAttribute('aria-busy')).toBe('false');
    });

    test('while a read runs Load all is aria-disabled and busy, and a press sends no second read', async () => {
        const cached = deferred<Answer>();
        getLibrary().mockReturnValueOnce(cached.promise);
        setup();
        loadAll();
        await waitFor(() => expect(loadAllButton().getAttribute('aria-busy')).toBe('true'));
        expect(loadAllButton().getAttribute('aria-disabled')).toBe('true');
        expect(loadAllButton().hasAttribute('disabled')).toBe(false);
        loadAll();
        expect(getLibrary()).toHaveBeenCalledTimes(1);
        await act(async () => cached.resolve(listing([photo(1)])));
        await opened();
    });

    test('while a preview is being re-checked a press of Load all sends no read', async () => {
        const fresh = deferred<Answer>();
        getLibrary()
            .mockResolvedValueOnce(listing([photo(1)], { preview: true }))
            .mockReturnValueOnce(fresh.promise);
        setup();
        loadAll();
        await screen.findByRole('button', { name: /^Photo 00000001:/ });
        expect(loadAllButton().getAttribute('aria-busy')).toBe('true');
        loadAll();
        expect(getLibrary()).toHaveBeenCalledTimes(2);
        await act(async () => fresh.resolve(listing([photo(1)])));
        await waitFor(() => expect(loadAllButton().getAttribute('aria-busy')).toBe('false'));
    });

    test('during a Refresh a press of Load all sends no read', async () => {
        setup();
        await loadedAll();
        const refreshed = deferred<Answer>();
        getLibrary().mockReturnValueOnce(refreshed.promise);
        fireEvent.click(screen.getByRole('button', { name: 'Refresh photos' }));
        await waitFor(() =>
            expect(screen.getByRole('button', { name: 'Refresh photos' }).getAttribute('aria-busy')).toBe('true'),
        );
        expect(loadAllButton().getAttribute('aria-disabled')).toBe('true');
        expect(loadAllButton().getAttribute('aria-busy')).toBe('false');
        loadAll();
        expect(getLibrary()).toHaveBeenCalledTimes(3);
        await act(async () => refreshed.resolve(listing([photo(1)])));
        await waitFor(() => expect(loadAllButton().getAttribute('aria-busy')).toBe('false'));
    });

    test('Load all after a Search empties the search box and reads the whole library', async () => {
        setup();
        fireEvent.change(searchBox(), { target: { value: 'sun' } });
        fireEvent.click(screen.getByRole('button', { name: 'Search' }));
        await waitFor(() => expect(getLibrary()).toHaveBeenLastCalledWith(7, 'sun', 'fresh', 'submit'));
        await opened();
        expect(searchBox().value).toBe('sun');
        loadAll();
        expect(searchBox().value).toBe('');
        await waitFor(() => expect(getLibrary()).toHaveBeenLastCalledWith(7, undefined, 'fresh', 'submit'));
        expect(getLibrary()).toHaveBeenCalledWith(7, undefined, 'cached', 'submit');
    });

    test('Load all pressed while a Search is running keeps the term and reads nothing', async () => {
        const searching = deferred<Answer>();
        getLibrary().mockReturnValueOnce(searching.promise);
        setup();
        fireEvent.change(searchBox(), { target: { value: 'sun' } });
        fireEvent.click(screen.getByRole('button', { name: 'Search' }));
        await waitFor(() => expect(loadAllButton().getAttribute('aria-disabled')).toBe('true'));
        // The read is the Search's, not Load all's: Load all is held but does not show itself busy.
        expect(loadAllButton().getAttribute('aria-busy')).toBe('false');
        loadAll();
        expect(searchBox().value).toBe('sun');
        expect(getLibrary()).toHaveBeenCalledTimes(1);
        await act(async () => searching.resolve(listing([photo(1)])));
        await opened();
    });

    test('while a submit is in flight Load all is held and sends no read', async () => {
        const { update } = setup();
        update({ submitting: true });
        expect(loadAllButton().getAttribute('aria-disabled')).toBe('true');
        loadAll();
        expect(getLibrary()).not.toHaveBeenCalled();
        update({ submitting: false });
        expect(loadAllButton().getAttribute('aria-disabled')).toBe('false');
        loadAll();
        await opened();
    });

    test('after Load all landed, a later Search read leaves Load all held but not busy', async () => {
        setup();
        await loadedAll();
        getLibrary().mockReturnValueOnce(deferred<Answer>().promise);
        fireEvent.click(screen.getByRole('button', { name: 'Search' }));
        await waitFor(() => expect(loadAllButton().getAttribute('aria-disabled')).toBe('true'));
        expect(loadAllButton().getAttribute('aria-busy')).toBe('false');
    });

    test('after Load all landed, the read of a refreshed submit leaves Load all held but not busy', async () => {
        const onSubmit = jest.fn<Promise<PickOutcome>, [string[]]>().mockResolvedValue('refreshed');
        setup({ onSubmit });
        await loadedAll();
        fireEvent.click(tile(1));
        getLibrary().mockReturnValueOnce(deferred<Answer>().promise);
        fireEvent.click(submitButton());
        await waitFor(() => expect(loadAllButton().getAttribute('aria-disabled')).toBe('true'));
        expect(loadAllButton().getAttribute('aria-busy')).toBe('false');
    });

    test('Search reads the library without Load all', async () => {
        setup();
        fireEvent.change(searchBox(), { target: { value: 'sun' } });
        fireEvent.click(screen.getByRole('button', { name: 'Search' }));
        await opened();
        expect(getLibrary()).toHaveBeenCalledWith(7, 'sun', 'fresh', 'submit');
        expect(idleLine()).toBeNull();
    });

    test('Auto from idle, a pick and Submit send the pick with no listing read', async () => {
        const { props } = setup();
        await auto([photo(9), photo(1)]);
        pickFromStrip(9);
        expect(submitButton().hasAttribute('disabled')).toBe(false);
        fireEvent.click(submitButton());
        await waitFor(() => expect(props.onSubmit).toHaveBeenCalledWith([idOf(9)]));
        expect(getLibrary()).not.toHaveBeenCalled();
    });

    test('while idle a pick shows as a tile with the answer’s thumbnail, unnumbered, and can be unticked', async () => {
        setup();
        await auto([photo(9), photo(1)]);
        pickFromStrip(9);
        const inGrid = idleTile(9);
        expect(inGrid.getAttribute('aria-pressed')).toBe('true');
        expect(inGrid.querySelector('img')?.getAttribute('src')).toContain(MEMBER);
        expect(inGrid.querySelector('.badge')).toBeNull();
        expect(idleLine()).toBeNull();
        expect(
            screen
                .getByText(
                    'Your picks can be submitted as they are. Load all photos or search to see the rest of your library.',
                )
                .getAttribute('role'),
        ).toBe('status');
    });

    test('a second Auto that fails clears the strip; unpicking the tile leaves it in place, focused and pickable again', async () => {
        setup();
        await auto([photo(9), photo(1)]);
        pickFromStrip(9);
        suggestPhotos().mockResolvedValueOnce(invalid<Suggestion>({ success: false, error: 'no-match' }));
        fireEvent.click(autoButton());
        await screen.findByRole('alert');
        expect(screen.queryByRole('region', { name: 'Suggestions' })).toBeNull();
        expect(idleTile(9).getAttribute('aria-pressed')).toBe('true');
        const kept = idleTile(9);
        kept.focus();
        fireEvent.click(kept);
        expect(countLine().textContent).toBe('Picked: 0/3 open slots');
        expect(idleTile(9)).toBe(kept);
        expect(kept.getAttribute('aria-pressed')).toBe('false');
        expect(document.activeElement).toBe(kept);
        expect(idleLine()).toBeTruthy();
        fireEvent.click(kept);
        expect(kept.getAttribute('aria-pressed')).toBe('true');
        expect(countLine().textContent).toBe('Picked: 1/3 open slots');
    });

    test('an unpicked idle tile is offered again only while there is room', async () => {
        setup({ max: 2 });
        await auto([photo(9), photo(1), photo(2)]);
        pickFromStrip(9);
        suggestPhotos().mockResolvedValueOnce(invalid<Suggestion>({ success: false, error: 'no-match' }));
        fireEvent.click(autoButton());
        await screen.findByRole('alert');
        fireEvent.click(idleTile(9));
        await auto([photo(1), photo(2)]);
        pickFromStrip(1);
        pickFromStrip(2);
        expect(idleTile(9).getAttribute('aria-pressed')).toBe('false');
        expect(idleTile(9).getAttribute('aria-disabled')).toBe('true');
    });

    test('a second Auto with a different ranking still shows the earlier pick', async () => {
        setup();
        await auto([photo(9), photo(1)]);
        pickFromStrip(9);
        await auto([photo(2), photo(3)]);
        expect(idleTile(9).getAttribute('aria-pressed')).toBe('true');
        expect(countLine().textContent).toBe('Picked: 1/3 open slots');
    });

    test('a second Auto that names no member keeps the earlier picks’ thumbnails', async () => {
        setup();
        await auto([photo(9)]);
        pickFromStrip(9);
        await auto([photo(2)], { memberId: null });
        expect(idleTile(9).querySelector('img')?.getAttribute('src')).toContain(MEMBER);
    });

    test('a refreshed submit while idle reads afresh and takes out a photo it marks not allowed', async () => {
        const onSubmit = jest.fn<Promise<PickOutcome>, [string[]]>().mockResolvedValue('refreshed');
        setup({ onSubmit });
        await auto([photo(9), photo(1)]);
        pickFromStrip(9);
        pickFromStrip(1);
        getLibrary().mockResolvedValue(listing([photo(1, { allowed: false }), photo(2)]));
        fireEvent.click(submitButton());
        await waitFor(() => expect(submitButton().textContent).toBe('Submit 1'));
        expect(getLibrary().mock.calls).toEqual([[7, undefined, 'fresh', 'submit']]);
        expect(screen.queryByRole('region', { name: 'Suggestions' })).toBeNull();
        expect(screen.getByRole('button', { name: /^Photo 00000009:/ }).getAttribute('aria-pressed')).toBe('true');
    });

    test('an Auto pick followed by a Load all that fails holds Submit and offers Retry', async () => {
        setup();
        await auto([photo(9)]);
        pickFromStrip(9);
        expect(submitButton().hasAttribute('disabled')).toBe(false);
        getLibrary().mockResolvedValueOnce(failed);
        loadAll();
        const retryButton = await screen.findByRole('button', { name: 'Retry' });
        expect(submitButton().hasAttribute('disabled')).toBe(true);
        fireEvent.click(retryButton);
        await opened();
        expect(getLibrary().mock.calls).toEqual([
            [7, undefined, 'cached', 'submit'],
            [7, undefined, 'fresh', 'submit'],
        ]);
    });

    test('the swap usage opens idle too, and Load all and Auto ask for swap eligibility', async () => {
        setup({ max: 1, usage: 'swap' });
        expect(getLibrary()).not.toHaveBeenCalled();
        expect(idleLine()).toBeTruthy();
        suggestPhotos().mockResolvedValueOnce(suggestion([photo(1)]));
        fireEvent.click(autoButton());
        await screen.findByRole('region', { name: 'Suggestions' });
        expect(suggestPhotos()).toHaveBeenCalledWith(7, 'swap');
        fireEvent.click(loadAllButton());
        await waitFor(() => expect(getLibrary()).toHaveBeenCalledTimes(2));
        expect(getLibrary().mock.calls).toEqual([
            [7, undefined, 'cached', 'swap'],
            [7, undefined, 'fresh', 'swap'],
        ]);
    });

    test('a usage change reads nothing, and the next Load all sends the new usage', async () => {
        const { update } = setup();
        update({ usage: 'swap' });
        expect(getLibrary()).not.toHaveBeenCalled();
        fireEvent.click(loadAllButton());
        await opened();
        expect(getLibrary()).toHaveBeenCalledWith(7, undefined, 'cached', 'swap');
    });
});

describe('photos the challenge refuses', () => {
    const refused = (n: number) => photo(n, { allowed: false, message: `No ${n}` });
    const hiddenLine = (count: number) => `Hidden: ${count} photo(s) GuruShots won't take in this challenge.`;
    const noneAccepted =
        "GuruShots won't take any of the listed photos in this challenge. Search by tag to find others, or upload new photos and press Refresh.";
    const has = (n: number) => screen.queryByRole('button', { name: new RegExp(`^Photo ${shortOf(n)}:`) }) !== null;
    const deferred = <T,>() => {
        let resolve!: (value: T) => void;
        const promise = new Promise<T>((r) => (resolve = r));
        return { promise, resolve };
    };
    const suggestPhotos = () => jest.mocked(window.api.suggestPhotos);
    const autoSuggesting = async (photos: LibraryPhoto[]) => {
        suggestPhotos().mockResolvedValueOnce({ success: true, memberId: MEMBER, photos, statsLimited: false });
        fireEvent.click(screen.getByRole('button', { name: 'Auto' }));
        await screen.findByRole('region', { name: 'Suggestions' });
    };
    const stripTile = (n: number) =>
        within(screen.getByRole('region', { name: 'Suggestions' })).getByRole('button', {
            name: new RegExp(`^Photo ${shortOf(n)}:`),
        });
    const gridTile = (n: number) =>
        screen
            .getAllByRole('button', { name: new RegExp(`^Photo ${shortOf(n)}:`) })
            .find((el) => !screen.getByRole('region', { name: 'Suggestions' }).contains(el)) as HTMLElement;

    const statusRegion = () => document.querySelector<HTMLElement>('[role="status"][tabindex="-1"]');

    test('are left out and counted, in the one status region that was mounted before anything was read', async () => {
        getLibrary().mockResolvedValue(listing([photo(1), refused(2), refused(3), photo(4)]));
        setup();
        const region = statusRegion();
        expect(region).not.toBeNull();
        expect(region?.textContent).toBe('');
        expect(region?.className).toContain('empty:hidden');
        await loadedAll();
        expect(has(2)).toBe(false);
        expect(has(3)).toBe(false);
        expect(has(4)).toBe(true);
        expect(statusRegion()).toBe(region);
        expect(region?.textContent).toBe(hiddenLine(2));
        expect(screen.queryByText(noneAccepted)).toBeNull();
    });

    test('the same region carries the nothing-to-pick line, and stays mounted through loading', async () => {
        const answer = deferred<Listing>();
        // The first read is held; the re-check that follows it answers the same.
        getLibrary()
            .mockResolvedValue(listing([refused(1), refused(2)]))
            .mockReturnValueOnce(answer.promise);
        setup();
        const region = statusRegion();
        loadAll();
        await screen.findByText('Loading your photos…');
        expect(statusRegion()).toBe(region);
        await act(async () => answer.resolve(listing([refused(1), refused(2)])));
        await screen.findByText(noneAccepted);
        expect(statusRegion()).toBe(region);
        expect(region?.textContent).toBe(`${hiddenLine(2)}${noneAccepted}`);
    });

    test('the region is still the same one when the read fails', async () => {
        getLibrary().mockResolvedValue(
            invalid<Awaited<ReturnType<WindowApi['getLibraryPhotos']>>>({
                success: false,
                error: 'Failed to read your photo library',
            }),
        );
        setup();
        const region = statusRegion();
        loadAll();
        await screen.findByRole('button', { name: 'Retry' });
        expect(statusRegion()).toBe(region);
        expect(region?.textContent).toBe('');
    });

    test('a cut-short listing says at least how many are hidden, and still counts the photos it listed', async () => {
        getLibrary().mockResolvedValue(listing([photo(1), refused(2), photo(3)], { truncated: true }));
        setup();
        await loadedAll();
        expect(screen.getByText("Hidden: at least 1 photo(s) GuruShots won't take in this challenge.")).toBeTruthy();
        expect(screen.getByText('Showing the first 3 photos. Search by tag to find others.')).toBeTruthy();
    });

    test('nothing is hidden before the listing can say what the challenge accepts', async () => {
        getLibrary().mockResolvedValue(listing([photo(1), refused(2)], { allowedKnown: false }));
        setup();
        loadAll();
        await screen.findByRole('button', { name: /^Photo 00000001:/ });
        expect(has(2)).toBe(true);
        expect(screen.queryByText(/^Hidden: /)).toBeNull();
    });

    test('a pick that a later read marks refused stays on screen with its reason, and Submit is not held for it', async () => {
        getLibrary().mockResolvedValue(listing([photo(1), refused(2), photo(3)]));
        setup();
        await autoSuggesting([photo(2)]);
        fireEvent.click(stripTile(2));
        loadAll();
        await waitFor(() => expect(gridTile(1).textContent).toContain('Can be entered'));
        expect(gridTile(2).getAttribute('aria-pressed')).toBe('true');
        expect(gridTile(2).textContent).toContain('No 2');
        // The pick is shown, so it is not among the hidden: nothing else is refused.
        expect(screen.queryByText(/^Hidden: /)).toBeNull();
        expect(submitButton().hasAttribute('disabled')).toBe(false);
        expect(submitButton().textContent).toBe('Submit 1');
    });

    test('a refused submit that comes back refreshed prunes that pick, and the photo is then hidden and counted', async () => {
        const onSubmit = jest.fn<Promise<PickOutcome>, [string[]]>().mockResolvedValue('refreshed');
        getLibrary().mockResolvedValue(listing([photo(1), refused(2), photo(3)]));
        setup({ onSubmit });
        await autoSuggesting([photo(2)]);
        fireEvent.click(stripTile(2));
        loadAll();
        await waitFor(() => expect(gridTile(1).textContent).toContain('Can be entered'));
        fireEvent.click(submitButton());
        await waitFor(() => expect(onSubmit).toHaveBeenCalledWith([idOf(2)]));
        await waitFor(() => expect(screen.queryByText(hiddenLine(1))).not.toBeNull());
        expect(submitButton().textContent).toBe('Submit');
        // The refreshed submit also cleared the strip, so each photo has just its grid tile.
        expect(has(2)).toBe(false);
        expect(tile(1).textContent).toContain('Can be entered');
    });

    test('a blocked photo is shown blocked even when it is refused too, and is not counted', async () => {
        getLibrary().mockResolvedValue(listing([photo(1), refused(2), refused(3)]));
        setup({ blocked: { ids: new Set([idOf(2)]), reasonKey: 'app.swapPickBlocked' } });
        await loadedAll();
        expect(tile(2).textContent).toContain('Already in this challenge');
        expect(has(3)).toBe(false);
        expect(screen.getByText(hiddenLine(1))).toBeTruthy();
    });

    test('says so when every listed photo is refused', async () => {
        getLibrary().mockResolvedValue(listing([refused(1), refused(2)]));
        setup();
        loadAll();
        expect(await screen.findByText(noneAccepted)).toBeTruthy();
        expect(screen.getByText(hiddenLine(2))).toBeTruthy();
        expect(screen.queryByText(/^No photos found/)).toBeNull();
    });

    test('says so when only blocked photos are left', async () => {
        getLibrary().mockResolvedValue(listing([photo(1), refused(2)]));
        setup({ blocked: { ids: new Set([idOf(1)]), reasonKey: 'app.swapPickBlocked' } });
        loadAll();
        expect(await screen.findByText(noneAccepted)).toBeTruthy();
        expect(tile(1).textContent).toContain('Already in this challenge');
    });

    test('does not say so while something is picked', async () => {
        getLibrary().mockResolvedValue(listing([refused(1), refused(2)]));
        setup();
        await autoSuggesting([photo(5)]);
        fireEvent.click(stripTile(5));
        loadAll();
        await screen.findByText(hiddenLine(2));
        expect(screen.queryByText(noneAccepted)).toBeNull();
    });

    test('a listing with no photos keeps its own texts and never says the others are refused', async () => {
        getLibrary().mockResolvedValue(listing([]));
        const { unmount } = setup();
        loadAll();
        expect(await screen.findByText(/^No photos found\./)).toBeTruthy();
        expect(screen.queryByText(noneAccepted)).toBeNull();
        unmount();
        getLibrary().mockResolvedValue(listing([], { wonIds: [idOf(9)], wonCount: 1 }));
        setup();
        loadAll();
        expect(await screen.findByText(/^No photos you can enter were found/)).toBeTruthy();
        expect(screen.queryByText(noneAccepted)).toBeNull();
    });

    test('the focus moves to the hidden line when the fresh read hides the tile it was on', async () => {
        const fresh = deferred<Listing>();
        getLibrary()
            .mockResolvedValueOnce(listing([photo(1), photo(2), photo(3)], { allowedKnown: false, preview: true }))
            .mockReturnValueOnce(fresh.promise);
        setup();
        loadAll();
        await screen.findByRole('button', { name: /^Photo 00000002:/ });
        tile(2).focus();
        expect(document.activeElement).toBe(tile(2));
        await act(async () => fresh.resolve(listing([photo(1), refused(2), photo(3)])));
        await waitFor(() => expect(has(2)).toBe(false));
        expect(document.activeElement).toBe(document.querySelector('[role="status"][tabindex="-1"]'));
        expect(document.activeElement?.textContent).toBe(hiddenLine(1));
    });

    test('the focus is left alone when it has moved off the tile before the read hides it', async () => {
        const fresh = deferred<Listing>();
        getLibrary()
            .mockResolvedValueOnce(listing([photo(1), photo(2), photo(3)], { allowedKnown: false, preview: true }))
            .mockReturnValueOnce(fresh.promise);
        setup();
        loadAll();
        await screen.findByRole('button', { name: /^Photo 00000002:/ });
        tile(2).focus();
        const search = screen.getByLabelText('Search your photos by tag');
        search.focus();
        await act(async () => fresh.resolve(listing([photo(1), refused(2), photo(3)])));
        await waitFor(() => expect(has(2)).toBe(false));
        expect(document.activeElement).toBe(search);
    });

    test('the focus stays on a tile that is still shown', async () => {
        const fresh = deferred<Listing>();
        getLibrary()
            .mockResolvedValueOnce(listing([photo(1), photo(2), photo(3)], { allowedKnown: false, preview: true }))
            .mockReturnValueOnce(fresh.promise);
        setup();
        loadAll();
        await screen.findByRole('button', { name: /^Photo 00000002:/ });
        tile(3).focus();
        await act(async () => fresh.resolve(listing([photo(1), refused(2), photo(3)])));
        await waitFor(() => expect(has(2)).toBe(false));
        expect(document.activeElement).toBe(tile(3));
    });

    test('the focus is not handed to the hidden line when the user moved it off the tile, even to a place that cannot hold it', async () => {
        const fresh = deferred<Listing>();
        getLibrary()
            .mockResolvedValueOnce(listing([photo(1), photo(2), photo(3)], { allowedKnown: false, preview: true }))
            .mockReturnValueOnce(fresh.promise);
        setup();
        loadAll();
        await screen.findByRole('button', { name: /^Photo 00000002:/ });
        tile(2).focus();
        // A click on the page's blank space: the focus falls to <body>, and the tile stays.
        tile(2).blur();
        await act(async () => undefined);
        expect(document.activeElement).toBe(document.body);
        await act(async () => fresh.resolve(listing([photo(1), refused(2), photo(3)])));
        await waitFor(() => expect(has(2)).toBe(false));
        expect(document.activeElement).toBe(document.body);
    });

    test('the focus moving from one tile to another keeps the hand-off for the one it lands on', async () => {
        const fresh = deferred<Listing>();
        getLibrary()
            .mockResolvedValueOnce(listing([photo(1), photo(2), photo(3)], { allowedKnown: false, preview: true }))
            .mockReturnValueOnce(fresh.promise);
        setup();
        loadAll();
        await screen.findByRole('button', { name: /^Photo 00000002:/ });
        tile(1).focus();
        fireEvent.blur(tile(1), { relatedTarget: tile(2) });
        tile(2).focus();
        await act(async () => undefined);
        await act(async () => fresh.resolve(listing([photo(1), refused(2), photo(3)])));
        await waitFor(() => expect(has(2)).toBe(false));
        expect(document.activeElement).toBe(statusRegion());
    });

    test('a blur that comes with the tile being removed keeps the hand-off', async () => {
        const fresh = deferred<Listing>();
        getLibrary()
            .mockResolvedValueOnce(listing([photo(1), photo(2), photo(3)], { allowedKnown: false, preview: true }))
            .mockReturnValueOnce(fresh.promise);
        setup();
        loadAll();
        await screen.findByRole('button', { name: /^Photo 00000002:/ });
        const focused = tile(2);
        focused.focus();
        // A browser that reports the blur of a tile it is taking out of the page: by then it is not connected.
        Object.defineProperty(focused, 'isConnected', { configurable: true, get: () => false });
        fireEvent.blur(focused);
        await act(async () => undefined);
        // The override is gone again before the read lands, so the tile leaves the page as it would for real.
        Reflect.deleteProperty(focused, 'isConnected');
        await act(async () => fresh.resolve(listing([photo(1), refused(2), photo(3)])));
        await waitFor(() => expect(has(2)).toBe(false));
        expect(document.activeElement).toBe(statusRegion());
    });

    test('a refused pick the user takes back stays on screen with its reason, until the next listing replaces it', async () => {
        getLibrary().mockResolvedValue(listing([photo(1), refused(2), photo(3)]));
        setup();
        await autoSuggesting([photo(2)]);
        fireEvent.click(stripTile(2));
        loadAll();
        await waitFor(() => expect(gridTile(1).textContent).toContain('Can be entered'));
        fireEvent.click(gridTile(2));
        expect(gridTile(2).getAttribute('aria-pressed')).toBe('false');
        expect(gridTile(2).textContent).toContain('No 2');
        expect(screen.queryByText(/^Hidden: /)).toBeNull();
        // A second photo taken back in the same listing is kept too.
        fireEvent.click(gridTile(1));
        fireEvent.click(gridTile(1));
        expect(gridTile(2)).toBeTruthy();
        // The next read is another listing: the normal rule hides the photo and counts it.
        fireEvent.click(screen.getByRole('button', { name: 'Refresh photos' }));
        await screen.findByText(hiddenLine(1));
        expect(has(2)).toBe(false);
    });

    test('a refused pick taken back from the strip stays on screen with its reason as well', async () => {
        getLibrary().mockResolvedValue(listing([photo(1), refused(2), photo(3)]));
        setup();
        await autoSuggesting([photo(2)]);
        fireEvent.click(stripTile(2));
        loadAll();
        await waitFor(() => expect(gridTile(1).textContent).toContain('Can be entered'));
        fireEvent.click(stripTile(2));
        expect(gridTile(2).getAttribute('aria-pressed')).toBe('false');
        expect(screen.queryByText(/^Hidden: /)).toBeNull();
    });

    test('with one slot, tapping another photo replaces a refused pick, which stays on screen with its reason and is not counted', async () => {
        getLibrary().mockResolvedValue(listing([photo(1), refused(2), photo(3)]));
        setup({ max: 1 });
        await autoSuggesting([photo(2)]);
        fireEvent.click(stripTile(2));
        loadAll();
        await waitFor(() => expect(gridTile(1).textContent).toContain('Can be entered'));
        fireEvent.click(gridTile(1));
        expect(gridTile(1).getAttribute('aria-pressed')).toBe('true');
        expect(gridTile(2).getAttribute('aria-pressed')).toBe('false');
        expect(gridTile(2).textContent).toContain('No 2');
        expect(screen.queryByText(/^Hidden: /)).toBeNull();
        // The next listing is another one: the refused photo is hidden and counted.
        fireEvent.click(screen.getByRole('button', { name: 'Refresh photos' }));
        await screen.findByText(hiddenLine(1));
        expect(has(2)).toBe(false);
    });

    test('with one slot, Add suggestions replaces a refused pick, which stays on screen with its reason and is not counted', async () => {
        getLibrary().mockResolvedValue(listing([photo(1), refused(2), photo(3)]));
        setup({ max: 1 });
        await autoSuggesting([photo(3), photo(2)]);
        fireEvent.click(stripTile(2));
        loadAll();
        await waitFor(() => expect(gridTile(1).textContent).toContain('Can be entered'));
        fireEvent.click(
            within(screen.getByRole('region', { name: 'Suggestions' })).getByRole('button', {
                name: 'Add suggestions',
            }),
        );
        expect(gridTile(3).getAttribute('aria-pressed')).toBe('true');
        expect(gridTile(2).getAttribute('aria-pressed')).toBe('false');
        expect(gridTile(2).textContent).toContain('No 2');
        expect(screen.queryByText(/^Hidden: /)).toBeNull();
    });
});
