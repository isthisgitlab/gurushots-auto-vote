/**
 * PhotoSubmitModal: the "Pick…" submit picker. The picker's own tiles (not numbered), a live cap that
 * can shrink while it is open, one-slot swapping, an inline error, a reload after a failure the card
 * refreshed for, and no way out while a submit is in flight. Translations are the real English strings.
 */

import { act, fireEvent, render, screen, waitFor, within } from './helpers/test-utils';
import { PhotoSubmitModal } from '@/components/app/PhotoSubmitModal';
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
        setup();
        await opened();
        expect(getLibrary().mock.calls).toEqual([
            [7, undefined, 'cached'],
            [7, undefined, 'fresh'],
        ]);
        expect(screen.getByText('Choose photos to submit')).toBeTruthy();
        expect(countLine().textContent).toBe('Picked: 0/3 open slots');
        expect(submitButton().hasAttribute('disabled')).toBe(true);
        expect(submitButton().textContent).toBe('Submit');
    });

    test('picked tiles are not numbered', async () => {
        setup();
        await opened();
        fireEvent.click(tile(2));
        expect(tile(2).getAttribute('aria-pressed')).toBe('true');
        expect(tile(2).getAttribute('aria-label')).not.toMatch(/Number/);
        expect(tile(2).querySelector('.badge')).toBeNull();
    });
});

describe('picking and submitting', () => {
    test('Submit names the count and sends the picked ids in the order picked', async () => {
        const { props } = setup();
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
        setup();
        await opened();
        fireEvent.click(tile(1));
        fireEvent.click(tile(1));
        expect(tile(1).getAttribute('aria-pressed')).toBe('false');
        expect(submitButton().hasAttribute('disabled')).toBe(true);
    });

    test('at the cap the other tiles are held and say the open slots are all picked', async () => {
        setup({ max: 2 });
        await opened();
        fireEvent.click(tile(1));
        fireEvent.click(tile(2));
        expect(tile(3).getAttribute('aria-disabled')).toBe('true');
        expect(tile(3).textContent).toContain('All open slots picked');
        fireEvent.click(tile(3));
        expect(countLine().textContent).toBe('Picked: 2/2 open slots');
    });

    test('with one open slot a tap swaps the pick instead of being refused', async () => {
        const { props } = setup({ max: 1 });
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
        setup({ onSubmit });
        await opened();
        fireEvent.change(screen.getByLabelText('Search your photos by tag'), { target: { value: 'sun' } });
        fireEvent.click(screen.getByRole('button', { name: 'Search' }));
        await waitFor(() => expect(getLibrary()).toHaveBeenLastCalledWith(7, 'sun', 'fresh'));
        await opened();
        fireEvent.click(tile(2));
        fireEvent.click(submitButton());
        await waitFor(() => expect(getLibrary()).toHaveBeenCalledTimes(4));
        expect(getLibrary()).toHaveBeenLastCalledWith(7, 'sun', 'fresh');
        await opened();
        expect(tile(2).getAttribute('aria-pressed')).toBe('true');
    });

    test('after a refreshed failure Submit stays held until the re-read listing is in', async () => {
        const onSubmit = jest.fn<Promise<PickOutcome>, [string[]]>().mockResolvedValue('refreshed');
        setup({ onSubmit });
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

    test('after a refreshed failure a picked photo the listing says is not allowed leaves the pick', async () => {
        const onSubmit = jest.fn<Promise<PickOutcome>, [string[]]>().mockResolvedValue('refreshed');
        setup({ onSubmit });
        await opened();
        fireEvent.click(tile(1));
        fireEvent.click(tile(2));
        getLibrary().mockResolvedValue(listing([photo(1), photo(2, { allowed: false }), photo(3)]));
        fireEvent.click(submitButton());
        await waitFor(() => expect(tile(2).getAttribute('aria-pressed')).toBe('false'));
        expect(tile(1).getAttribute('aria-pressed')).toBe('true');
        expect(submitButton().textContent).toBe('Submit 1');
    });

    test('after a refreshed failure a picked photo the re-read listing reports as won leaves the pick', async () => {
        const onSubmit = jest.fn<Promise<PickOutcome>, [string[]]>().mockResolvedValue('refreshed');
        setup({ onSubmit });
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
        setup({ onSubmit });
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
        const { update } = setup();
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

    test('a failure that changed nothing does not read the listing again', async () => {
        const onSubmit = jest.fn<Promise<PickOutcome>, [string[]]>().mockResolvedValue('failed');
        setup({ onSubmit });
        await opened();
        fireEvent.click(tile(1));
        fireEvent.click(submitButton());
        await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
        await act(async () => undefined);
        expect(getLibrary()).toHaveBeenCalledTimes(2);
    });

    test('a search that no longer lists a picked photo keeps the pick', async () => {
        const { props } = setup();
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
        setup();
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
        await act(async () =>
            fresh.resolve(listing([photo(1, { allowed: false, message: 'Already used' }), photo(2)])),
        );
        await waitFor(() => expect(screen.getByText('Already used')).toBeTruthy());
        expect(screen.queryByText(/as last loaded/)).toBeNull();
        expect(tile(2).getAttribute('aria-disabled')).toBe('false');
        fireEvent.click(tile(2));
        expect(submitButton().hasAttribute('disabled')).toBe(false);
    });

    test('a re-check that failed keeps picking held and says so; Refresh tries again and a listing that arrives unlocks it', async () => {
        getLibrary()
            .mockResolvedValueOnce(listing([photo(1)]))
            .mockResolvedValueOnce(failure);
        setup();
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
        setup();
        await opened();
        getLibrary().mockResolvedValueOnce(failure);
        fireEvent.click(refreshButton());
        await waitFor(() => expect(tile(1).textContent).toContain(LOCKED));
        getLibrary().mockResolvedValueOnce(listing([photo(1)]));
        fireEvent.click(refreshButton());
        await waitFor(() => expect(tile(1).getAttribute('aria-disabled')).toBe('false'));
    });

    test('Refresh is held while a submit is in flight', async () => {
        const { update } = setup();
        await opened();
        expect(refreshButton().hasAttribute('disabled')).toBe(false);
        update({ submitting: true });
        expect(refreshButton().hasAttribute('disabled')).toBe(true);
    });

    test('after a Refresh the pick is checked against what it brought: a photo that is no longer allowed, or has won, leaves it', async () => {
        setup();
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
        expect(tile(2).getAttribute('aria-pressed')).toBe('false');
    });

    test('a check waiting for a Refresh waits for the fresh listing: a preview in between prunes nothing', async () => {
        setup();
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
        await waitFor(() => expect(tile(2).getAttribute('aria-pressed')).toBe('false'));
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
        setup();
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
        await waitFor(() => expect(tile(2).getAttribute('aria-pressed')).toBe('false'));
        expect(tile(1).getAttribute('aria-pressed')).toBe('true');
    });

    test('a Refresh that lands while a submit is in flight leaves the pick alone, and the check runs once the submit has ended', async () => {
        const { update } = setup();
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
        await waitFor(() => expect(tile(2).getAttribute('aria-pressed')).toBe('false'));
    });
});

describe('failure text', () => {
    test('shows the translated error inline as an alert', async () => {
        setup({ error: 'The photos were not submitted. Pick other photos.' });
        await opened();
        expect(screen.getByRole('alert').textContent).toBe('The photos were not submitted. Pick other photos.');
    });
});

describe('the cap changing while open', () => {
    test('a cap below the picks says so and holds Submit until enough are taken back', async () => {
        const { update } = setup({ max: 3 });
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
        const { update, props } = setup({ max: 3 });
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
        const { update } = setup({ max: 2, onClose });
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
        const { update } = setup({ max: 1 });
        await opened();
        update({ max: 0, error: 'The photos may have been submitted.' });
        expect(screen.queryByRole('alert')).toBeNull();
        expect(screen.getByText(/^No open slots left/)).toBeTruthy();
    });

    test('with no open slots a submit in flight keeps Close held', async () => {
        const { update } = setup({ max: 1 });
        await opened();
        update({ max: 0, submitting: true });
        expect(screen.getAllByRole('button', { name: 'Close' }).every((b) => b.hasAttribute('disabled'))).toBe(true);
    });
});

describe('closing', () => {
    test('Cancel and Escape close it while idle', async () => {
        const onClose = jest.fn();
        setup({ onClose });
        await opened();
        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
        expect(onClose).toHaveBeenCalledTimes(1);
        fireEvent.keyDown(document, { key: 'Escape' });
        expect(onClose).toHaveBeenCalledTimes(2);
    });

    test('while a submit is in flight nothing closes it: no Cancel, no Escape, no ✕, and Submit shows busy', async () => {
        const onClose = jest.fn();
        setup({ onClose, submitting: true });
        await opened();
        expect(screen.getByRole('button', { name: 'Cancel' }).hasAttribute('disabled')).toBe(true);
        expect(screen.queryByRole('button', { name: 'Close modal' })).toBeNull();
        fireEvent.keyDown(document, { key: 'Escape' });
        fireEvent.click(document.querySelector('.modal-backdrop')!);
        expect(onClose).not.toHaveBeenCalled();
        const submit = screen.getByRole('button', { name: /Submit/ });
        expect(submit.getAttribute('aria-busy')).toBe('true');
        expect(submit.hasAttribute('disabled')).toBe(true);
    });
});

describe('the listing states', () => {
    test('a failed read shows the error with Retry, which reads again', async () => {
        getLibrary().mockResolvedValueOnce(invalid({ success: false, error: 'Failed to read your photo library' }));
        setup();
        await screen.findByRole('alert');
        fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
        await opened();
        expect(getLibrary()).toHaveBeenCalledTimes(2);
    });

    test('a superseded answer offers Retry too', async () => {
        getLibrary().mockResolvedValueOnce(invalid({ success: false, error: 'superseded' }));
        setup();
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
    };

    test('texts replace the title, help, count and both submit labels', async () => {
        setup({ max: 1, texts: swapTexts });
        await opened();
        expect(screen.getByText('Choose the photo to swap in')).toBeTruthy();
        expect(screen.getByText(/^The photo you pick replaces the current one as is/)).toBeTruthy();
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
        const { unmount } = setup({ notice: 'No different photo is available.' });
        await opened();
        const notice = screen.getByText('No different photo is available.');
        expect(notice.closest('[role="status"]')?.className).toContain('alert-info');
        unmount();
        setup();
        await opened();
        expect(document.querySelector('.alert-info')).toBeNull();
    });

    test('blocked photos show their reason and cannot be picked', async () => {
        const { props } = setup({
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
        setup({ max: 1, blocked: { ids: new Set([idOf(1)]), reasonKey: 'app.swapPickBlocked' } });
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

    test('the help line is shown always, and a swap picker (no suggest) has no Auto', async () => {
        const { unmount } = setup({ suggest: true });
        await opened();
        expect(
            screen.getByText(
                'Auto ranks your photos by your auto-submit rules, including the local image check. Nothing is submitted.',
            ),
        ).toBeTruthy();
        expect(autoButton().getAttribute('aria-disabled')).toBe('false');
        unmount();
        setup({ max: 1, suggest: false });
        await opened();
        expect(screen.queryByRole('button', { name: 'Auto' })).toBeNull();
        expect(screen.queryByText(/Auto ranks your photos/)).toBeNull();
    });

    test('while it runs Auto is aria-disabled and busy, keeps focus and ignores a press, and a status line says nothing is submitted', async () => {
        const answer = deferred<Suggestion>();
        suggestPhotos().mockReturnValueOnce(answer.promise);
        setup({ suggest: true });
        await opened();
        autoButton().focus();
        fireEvent.click(autoButton());
        await waitFor(() => expect(autoButton().getAttribute('aria-busy')).toBe('true'));
        expect(autoButton().getAttribute('aria-disabled')).toBe('true');
        // Not `disabled`: that would drop the keyboard focus to <body>.
        expect(autoButton().hasAttribute('disabled')).toBe(false);
        expect(document.activeElement).toBe(autoButton());
        expect(screen.getByText('Ranking your photos… this can take a minute. Nothing is submitted.')).toBeTruthy();
        expect(suggestPhotos()).toHaveBeenCalledWith(7);
        fireEvent.click(autoButton());
        expect(suggestPhotos()).toHaveBeenCalledTimes(1);
        await act(async () => answer.resolve(suggestion([photo(2)])));
        expect(autoButton().getAttribute('aria-disabled')).toBe('false');
        expect(screen.queryByText(/Ranking your photos/)).toBeNull();
    });

    test('one status region is always mounted: empty at first, the running text, then the count read out only', async () => {
        const answer = deferred<Suggestion>();
        suggestPhotos().mockReturnValueOnce(answer.promise);
        setup({ suggest: true });
        await opened();
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
        expect(within(strip()).getByText('Suggestions: 2').getAttribute('aria-live')).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: 'Refresh photos' }));
        await waitFor(() => expect(region?.textContent).toBe(''));
    });

    test('a swap picker (no Auto) has no such status region', async () => {
        setup({ max: 1, suggest: false });
        await opened();
        expect(screen.getAllByRole('status').filter((el) => el.getAttribute('aria-live') === 'polite')).toEqual([]);
    });

    test('the strip lists the suggestions in the returned order with fixed rank badges, and keeps it after a tap', async () => {
        setup({ suggest: true });
        await opened();
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
        const { update } = setup({ suggest: true });
        await opened();
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
        setup({ suggest: true });
        await opened();
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
        setup({ suggest: true });
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
        const { props } = setup({ suggest: true, max: 3 });
        await opened();
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
        setup({ suggest: true, max: 3 });
        await opened();
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
        setup({ suggest: true, max: 1 });
        await opened();
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
        setup({ suggest: true });
        await screen.findByRole('button', { name: /^Photo 00000001:/ });
        await press([photo(1)]);
        fireEvent.click(addButton());
        expect(addButton().hasAttribute('disabled')).toBe(true);
        expect(submitButton().hasAttribute('disabled')).toBe(true);
    });

    test('a Refresh clears the strip and drops an answer still on its way', async () => {
        const answer = deferred<Suggestion>();
        suggestPhotos().mockReturnValueOnce(answer.promise);
        setup({ suggest: true });
        await opened();
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
        setup({ suggest: true });
        await opened();
        fireEvent.click(autoButton());
        await waitFor(() => expect(autoButton().getAttribute('aria-disabled')).toBe('true'));
        fireEvent.click(screen.getByRole('button', { name: 'Refresh photos' }));
        await act(async () => answer.resolve(failure('no-match')));
        expect(screen.queryByRole('alert')).toBeNull();
    });

    test('a failed press after a success leaves no strip and shows the alert, keeping the picked suggestions’ tiles', async () => {
        setup({ suggest: true });
        await opened();
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

    test('after a refreshed submit a picked suggestion the re-read listing does not return leaves the pick', async () => {
        const onSubmit = jest.fn<Promise<PickOutcome>, [string[]]>().mockResolvedValue('refreshed');
        setup({ suggest: true, onSubmit });
        await opened();
        await press([photo(9), photo(1)]);
        fireEvent.click(stripTile(9));
        fireEvent.click(stripTile(1));
        expect(countLine().textContent).toBe('Picked: 2/3 open slots');
        // The re-read no longer has 9 (it was entered meanwhile) and still has 1.
        getLibrary().mockResolvedValue(listing([photo(1), photo(2), photo(3), photo(4)]));
        fireEvent.click(submitButton());
        await waitFor(() => expect(countLine().textContent).toBe('Picked: 1/3 open slots'));
        expect(screen.queryByRole('region', { name: 'Suggestions' })).toBeNull();
        expect(tile(1).getAttribute('aria-pressed')).toBe('true');
        expect(screen.queryByRole('button', { name: /^Photo 00000009:/ })).toBeNull();
    });

    test('a submit that comes back refreshed clears the strip, and one that failed leaves it', async () => {
        const onSubmit = jest.fn<Promise<PickOutcome>, [string[]]>().mockResolvedValue('failed');
        setup({ suggest: true, onSubmit });
        await opened();
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
        const { unmount } = setup({ suggest: true });
        await opened();
        fireEvent.click(autoButton());
        await waitFor(() => expect(autoButton().getAttribute('aria-disabled')).toBe('true'));
        unmount();
        await act(async () => answer.resolve(suggestion([photo(2)])));
        expect(document.querySelector('[role="dialog"]')).toBeNull();
    });

    test('when popularity stats were limited a line says the ranking leans on tags and the image check', async () => {
        setup({ suggest: true });
        await opened();
        await press([photo(1)], { statsLimited: true });
        expect(
            within(strip()).getByText(
                "Popularity stats couldn't all be read (the lookups kept failing), so this ranking leans on tags and the image check.",
            ),
        ).toBeTruthy();
    });

    test('no stats line when they were all read', async () => {
        setup({ suggest: true });
        await opened();
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
        ['account-changed', /^The photos were not ranked\. You switched accounts while it ran\. Reopen Pick…\.$/],
        ['challenge-ended', /^The photos were not ranked\. This challenge has ended or could not be read/],
        ['fetch-failed', /^The photos were not ranked\. GuruShots did not answer/],
        ['suggest-failed', /^The photos were not ranked\. GuruShots did not answer/],
        ['invalid-args', /^The action could not run/],
        ['something raw', /^The photos were not ranked\. GuruShots did not answer/],
    ])('the failure %j is an inline alert in words, never the code', async (code, text) => {
        suggestPhotos().mockResolvedValueOnce(failure(code));
        setup({ suggest: true });
        await opened();
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
        setup({ suggest: true });
        await opened();
        fireEvent.click(autoButton());
        const alert = await screen.findByRole('alert');
        expect(alert.textContent).toMatch(/^The photos were not ranked\. GuruShots did not answer/);
        expect(alert.textContent).not.toContain('ECONNRESET');
    });
});
