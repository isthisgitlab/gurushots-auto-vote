/**
 * PhotoSubmitModal: the "Pick…" submit picker. The picker's own tiles (not numbered), a live cap that
 * can shrink while it is open, one-slot swapping, an inline error, a reload after a failure the card
 * refreshed for, and no way out while a submit is in flight. Translations are the real English strings.
 */

import { act, fireEvent, render, screen, waitFor } from './helpers/test-utils';
import { PhotoSubmitModal } from '@/components/app/PhotoSubmitModal';
import type { PickOutcome } from '@/components/app/PhotoSubmitModal';
import { rememberCurrentMember } from '@/api/useChosenPhotosOwner';
import { mockTranslator } from './helpers/setup';
import { app } from '../../src/ts/translations/english';
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
    key.startsWith('app.') ? ((app as Record<string, string>)[key.slice(4)] ?? key) : key;

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
