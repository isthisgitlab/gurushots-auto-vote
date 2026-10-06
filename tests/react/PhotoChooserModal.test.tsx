/**
 * PhotoChooserModal: the Chosen Photos chooser. Selection is a set capped at
 * MAX_CHOSEN_PHOTOS, selected photos stay pinned first, a chosen id the listing
 * lacks gets its own tile, eligibility shows as text, search runs on submit and
 * late responses are dropped. Translations are the real English strings so the
 * tiles are told apart by their accessible names.
 */

import { act, fireEvent, render, screen, waitFor } from './helpers/test-utils';
import { PhotoChooserModal } from '@/components/app/PhotoChooserModal';
import { Modal } from '@/components/ui/Modal';
import { rememberCurrentMember } from '@/api/useChosenPhotosOwner';
import { mockTranslator } from './helpers/setup';
import { app } from '../../src/ts/translations/english';
import { MAX_CHOSEN_PHOTOS } from '../../src/ts/settings/limits';
import { invalid } from '../helpers/invalid';
import type { WindowApi } from '../../src/ts/types/ipc';

type Listing = Extract<Awaited<ReturnType<WindowApi['getLibraryPhotos']>>, { success: true }>;
type LibraryPhoto = Listing['photos'][number];

const MEMBER = 'c'.repeat(32);
// 32-hex ids, so buildPhotoUrl accepts them; the first 8 characters tell tiles apart.
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
    allowedKnown: true,
    ...over,
});

const english = (key: string) =>
    key.startsWith('app.') ? ((app as Record<string, string>)[key.slice(4)] ?? key) : key;

const deferred = <T,>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => {
        resolve = res;
    });
    return { promise, resolve };
};

const getLibrary = () => jest.mocked(window.api.getLibraryPhotos);

const tile = (n: number) => screen.getByRole('button', { name: new RegExp(`^Photo ${shortOf(n)}:`) });

const setup = (
    over: Partial<{
        value: string[];
        challengeId: string | number | null;
        onSave: jest.MockedFunction<(ids: string[]) => boolean | Promise<boolean>>;
        onClose: jest.MockedFunction<() => void>;
    }> = {},
) => {
    const props = {
        isOpen: true,
        onClose: jest.fn(),
        value: [] as string[],
        challengeId: 7 as string | number | null,
        onSave: jest.fn().mockResolvedValue(true),
        ...over,
    };
    return { ...props, ...render(<PhotoChooserModal {...props} />) };
};

beforeEach(() => {
    mockTranslator.t.mockImplementation(english);
    rememberCurrentMember(null);
    window.api.getSetting = jest.fn().mockResolvedValue('');
    window.api.getLibraryPhotos = jest.fn().mockResolvedValue(listing([photo(1), photo(2), photo(3)]));
});

afterEach(() => {
    mockTranslator.t.mockImplementation((key) => key);
});

describe('listing and tiles', () => {
    test('renders nothing while closed', () => {
        const { container } = render(
            <PhotoChooserModal isOpen={false} onClose={jest.fn()} value={[]} onSave={jest.fn()} />,
        );
        expect(container.querySelector('[role="dialog"]')).toBeNull();
    });

    test('shows the loader, then a tile per photo with a lazy, referrer-less CDN thumbnail', async () => {
        const pending = deferred<Listing>();
        getLibrary().mockReturnValueOnce(invalid(pending.promise));
        setup();
        expect(screen.getByText('Loading your photos…')).toBeTruthy();
        await act(async () => pending.resolve(listing([photo(1)])));
        await screen.findByRole('button', { name: /^Photo 00000001:/ });
        const img = tile(1).querySelector('img')!;
        expect(img.getAttribute('src')).toBe(`https://photos.gurushots.com/unsafe/240x240/${MEMBER}/3_${idOf(1)}.jpg`);
        expect(img.getAttribute('loading')).toBe('lazy');
        expect(img.getAttribute('referrerpolicy')).toBe('no-referrer');
        expect(img.getAttribute('alt')).toBe('');
        expect(screen.getByText('tag1')).toBeTruthy();
    });

    test('reads the library through the challenge it was opened for', async () => {
        setup({ challengeId: 42 });
        await screen.findByRole('button', { name: /^Photo 00000001:/ });
        expect(getLibrary()).toHaveBeenCalledWith(42, undefined);
    });

    test('a photo with no usable URL becomes a text tile with its tags and short id', async () => {
        getLibrary().mockResolvedValue(
            listing([photo(1, { labels: ['red', 'sea'] }), photo(2, { labels: [] })], { memberId: null }),
        );
        setup();
        const first = await screen.findByRole('button', { name: /^Photo 00000001:/ });
        expect(first.querySelector('img')).toBeNull();
        expect(first.textContent).toContain('red, sea');
        expect(first.textContent).toContain(shortOf(1));
        expect(tile(2).textContent).toContain('No tags');
    });

    test('a thumbnail that fails to load falls back to the text tile', async () => {
        const RealImage = window.Image;
        window.Image = invalid(
            class {
                onerror?: () => void;
                set src(_url: string) {
                    queueMicrotask(() => this.onerror?.());
                }
            },
        );
        try {
            setup();
            await screen.findByRole('button', { name: /^Photo 00000001:/ });
            await waitFor(() => expect(tile(1).querySelector('img')).toBeNull());
            expect(tile(1).textContent).toContain(shortOf(1));
        } finally {
            window.Image = RealImage;
        }
    });

    test('server-supplied tags and reasons are rendered as text, never as markup', async () => {
        getLibrary().mockResolvedValue(
            listing([photo(1, { labels: ['<img src=x onerror=alert(1)>'], allowed: false, message: '<b>no</b>' })]),
        );
        setup();
        await screen.findByRole('button', { name: /^Photo 00000001:/ });
        expect(document.querySelector('[role="dialog"] b')).toBeNull();
        expect(document.querySelector('img[src="x"]')).toBeNull();
        expect(screen.getByText('<b>no</b>')).toBeTruthy();
    });

    test('shows the empty state when the library has no photos', async () => {
        getLibrary().mockResolvedValue(listing([]));
        setup();
        expect(await screen.findByText(/No photos found/)).toBeTruthy();
    });

    test('says when the listing was cut off', async () => {
        getLibrary().mockResolvedValue(listing([photo(1), photo(2)], { truncated: true }));
        setup();
        expect(await screen.findByText('Showing the first 2 photos. Search by tag to find others.')).toBeTruthy();
    });

    test('no truncation note for a complete listing', async () => {
        setup();
        await screen.findByRole('button', { name: /^Photo 00000001:/ });
        expect(screen.queryByText(/Showing the first/)).toBeNull();
    });
});

describe('selection', () => {
    test('toggles a photo on and off (aria-pressed) and saves the chosen ids', async () => {
        const { onSave, onClose } = setup();
        await screen.findByRole('button', { name: /^Photo 00000001:/ });
        expect(tile(2).getAttribute('aria-pressed')).toBe('false');
        fireEvent.click(tile(2));
        fireEvent.click(tile(3));
        expect(tile(2).getAttribute('aria-pressed')).toBe('true');
        fireEvent.click(tile(3));
        expect(screen.getByRole('status').textContent).toBe(`1 of ${MAX_CHOSEN_PHOTOS} chosen`);
        fireEvent.click(screen.getByRole('button', { name: 'Use these photos' }));
        await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
        expect(onSave).toHaveBeenCalledWith([idOf(2)]);
    });

    test('starts from the saved value', async () => {
        setup({ value: [idOf(1)] });
        await screen.findByRole('button', { name: /^Photo 00000001:/ });
        expect(tile(1).getAttribute('aria-pressed')).toBe('true');
    });

    test('selected photos are pinned above the rest', async () => {
        getLibrary().mockResolvedValue(listing([photo(1), photo(2), photo(3)]));
        setup({ value: [idOf(3)] });
        await screen.findByRole('button', { name: /^Photo 00000001:/ });
        const order = screen
            .getAllByRole('button', { name: /^Photo / })
            .map((button) => button.getAttribute('aria-label'));
        expect(order.map((label) => label!.slice(6, 14))).toEqual([shortOf(3), shortOf(1), shortOf(2)]);
    });

    test('a chosen photo the listing lacks gets a not-available tile that can still be removed', async () => {
        getLibrary().mockResolvedValue(listing([photo(1), photo(2)]));
        setup({ value: [idOf(9)] });
        const missing = await screen.findByRole('button', { name: new RegExp(`^Photo ${shortOf(9)}:`) });
        expect(missing.textContent).toContain(
            'Not available for this challenge (in another challenge, deleted, or beyond the first 2 photos)',
        );
        expect(missing.getAttribute('aria-pressed')).toBe('true');
        fireEvent.click(missing);
        expect(screen.queryByRole('button', { name: new RegExp(`^Photo ${shortOf(9)}:`) })).toBeNull();
    });

    test('stops at the cap: other photos are disabled, selected ones can still be removed', async () => {
        const many = Array.from({ length: MAX_CHOSEN_PHOTOS + 1 }, (_, n) => photo(n + 1));
        getLibrary().mockResolvedValue(listing(many));
        setup({ value: many.slice(0, MAX_CHOSEN_PHOTOS).map((p) => p.id) });
        await screen.findByRole('button', { name: /^Photo 00000001:/ });
        const extra = tile(MAX_CHOSEN_PHOTOS + 1) as HTMLButtonElement;
        expect(extra.disabled).toBe(true);
        expect((tile(1) as HTMLButtonElement).disabled).toBe(false);
        fireEvent.click(tile(1));
        expect((tile(MAX_CHOSEN_PHOTOS + 1) as HTMLButtonElement).disabled).toBe(false);
    });

    test('Clear empties the selection and Cancel closes without saving', async () => {
        const { onSave, onClose } = setup({ value: [idOf(1)] });
        await screen.findByRole('button', { name: /^Photo 00000001:/ });
        fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
        expect(tile(1).getAttribute('aria-pressed')).toBe('false');
        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(onSave).not.toHaveBeenCalled();
    });
});

describe('eligibility', () => {
    test('a refused photo is greyed out with its reason as visible text and cannot be added', async () => {
        getLibrary().mockResolvedValue(
            listing([photo(1, { allowed: false, message: 'Already in another challenge' }), photo(2)]),
        );
        setup();
        const blocked = (await screen.findByRole('button', { name: /^Photo 00000001:/ })) as HTMLButtonElement;
        expect(blocked.disabled).toBe(true);
        expect(blocked.className).toContain('opacity-50');
        expect(screen.getByText('Already in another challenge')).toBeTruthy();
        expect(screen.getByText('Can be entered')).toBeTruthy();
    });

    test('a refused photo without a message gets a generic reason, and stays removable once chosen', async () => {
        getLibrary().mockResolvedValue(listing([photo(1, { allowed: false })]));
        setup({ value: [idOf(1)] });
        const blocked = (await screen.findByRole('button', { name: /^Photo 00000001:/ })) as HTMLButtonElement;
        expect(screen.getByText('Not eligible for this challenge')).toBeTruthy();
        expect(blocked.disabled).toBe(false);
    });

    test('without a challenge the listing says eligibility is only checked at submit time', async () => {
        getLibrary().mockResolvedValue(listing([photo(1, { allowed: false })], { allowedKnown: false }));
        setup({ challengeId: null });
        const only = (await screen.findByRole('button', { name: /^Photo 00000001:/ })) as HTMLButtonElement;
        expect(screen.getByText(/Eligibility is not checked here/)).toBeTruthy();
        expect(only.disabled).toBe(false);
        expect(screen.queryByText('Not eligible for this challenge')).toBeNull();
        expect(screen.queryByText('Can be entered')).toBeNull();
        expect(getLibrary()).toHaveBeenCalledWith(null, undefined);
    });
});

describe('search', () => {
    test('searches on submit, not while typing', async () => {
        setup();
        await screen.findByRole('button', { name: /^Photo 00000001:/ });
        const box = screen.getByLabelText('Search your photos by tag');
        fireEvent.change(box, { target: { value: '  cat ' } });
        expect(getLibrary()).toHaveBeenCalledTimes(1);
        fireEvent.submit(box.closest('form')!);
        await waitFor(() => expect(getLibrary()).toHaveBeenCalledTimes(2));
        expect(getLibrary()).toHaveBeenLastCalledWith(7, 'cat');
    });

    test('a selected photo a narrower search no longer lists keeps its tile', async () => {
        getLibrary()
            .mockResolvedValueOnce(listing([photo(1), photo(2)]))
            .mockResolvedValueOnce(listing([photo(3)]));
        setup({ value: [idOf(1)] });
        await screen.findByRole('button', { name: /^Photo 00000001:/ });
        fireEvent.change(screen.getByLabelText('Search your photos by tag'), { target: { value: 'x' } });
        fireEvent.submit(screen.getByLabelText('Search your photos by tag').closest('form')!);
        await screen.findByRole('button', { name: /^Photo 00000003:/ });
        // Known from the first listing: still the photo, not a "not available" tile.
        expect(tile(1).textContent).not.toContain('Not available');
        expect(tile(1).getAttribute('aria-pressed')).toBe('true');
    });

    test('drops a late response for a search that has been replaced', async () => {
        const first = deferred<Listing>();
        const second = deferred<Listing>();
        getLibrary().mockReturnValueOnce(invalid(first.promise)).mockReturnValueOnce(invalid(second.promise));
        setup();
        const box = screen.getByLabelText('Search your photos by tag');
        fireEvent.change(box, { target: { value: 'b' } });
        fireEvent.submit(box.closest('form')!);
        await act(async () => second.resolve(listing([photo(2)])));
        await screen.findByRole('button', { name: /^Photo 00000002:/ });
        await act(async () => first.resolve(listing([photo(1)])));
        expect(screen.queryByRole('button', { name: /^Photo 00000001:/ })).toBeNull();
        expect(tile(2)).toBeTruthy();
    });

    test('a response that arrives after the modal closed changes nothing', async () => {
        const pending = deferred<Listing>();
        getLibrary().mockReturnValueOnce(invalid(pending.promise));
        const { rerender, onClose, onSave } = setup();
        rerender(<PhotoChooserModal isOpen={false} onClose={onClose} value={[]} onSave={onSave} />);
        await act(async () => pending.resolve(listing([photo(1)])));
        expect(screen.queryByRole('button', { name: /^Photo / })).toBeNull();
    });

    test('a superseded answer is dropped silently', async () => {
        getLibrary().mockResolvedValue({ success: false, error: 'superseded' });
        setup();
        await act(async () => undefined);
        expect(screen.getByText('Loading your photos…')).toBeTruthy();
        expect(screen.queryByRole('alert')).toBeNull();
    });
});

describe('failures', () => {
    test('a failed read shows what happened, why and what next, and Retry reads again with the last search', async () => {
        getLibrary()
            .mockResolvedValueOnce(invalid(null))
            .mockResolvedValueOnce(listing([photo(1)]));
        setup();
        const alert = await screen.findByRole('alert');
        expect(alert.textContent).toContain("Your photos couldn't be loaded because");
        expect(alert.textContent).toContain('Try again');
        fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
        await screen.findByRole('button', { name: /^Photo 00000001:/ });
        expect(getLibrary()).toHaveBeenLastCalledWith(7, undefined);
    });

    test('an error carries its own text as a detail; invalid-args is translated', async () => {
        getLibrary().mockResolvedValueOnce({ success: false, error: 'Failed to read your photo library' });
        const view = setup();
        expect((await screen.findByRole('alert')).textContent).toContain('Failed to read your photo library');
        view.unmount();

        mockTranslator.t.mockImplementation((key) =>
            key === 'errors.actionInvalidArgs' ? 'Bad request' : english(key),
        );
        getLibrary().mockResolvedValueOnce({ success: false, error: 'invalid-args' });
        setup();
        expect((await screen.findByRole('alert')).textContent).toContain('Bad request');
    });

    test('retry keeps the submitted search', async () => {
        getLibrary()
            .mockResolvedValueOnce(listing([photo(1)]))
            .mockResolvedValueOnce(invalid(null));
        setup();
        await screen.findByRole('button', { name: /^Photo 00000001:/ });
        const box = screen.getByLabelText('Search your photos by tag');
        fireEvent.change(box, { target: { value: 'dog' } });
        fireEvent.submit(box.closest('form')!);
        await screen.findByRole('alert');
        fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
        await waitFor(() => expect(getLibrary()).toHaveBeenLastCalledWith(7, 'dog'));
    });

    test('with no challenge to read the library through it explains what is needed', async () => {
        getLibrary().mockResolvedValue({ success: false, error: 'no-challenge-context' });
        setup({ challengeId: null });
        expect((await screen.findByRole('alert')).textContent).toContain('no active or joinable challenge');
    });

    test('a save the caller refuses keeps the modal open on an error', async () => {
        const onSave = jest.fn().mockResolvedValue(false);
        const { onClose } = setup({ onSave });
        await screen.findByRole('button', { name: /^Photo 00000001:/ });
        fireEvent.click(screen.getByRole('button', { name: 'Use these photos' }));
        expect((await screen.findByRole('alert')).textContent).toContain("weren't saved");
        expect(onClose).not.toHaveBeenCalled();
        // A second attempt clears the error before trying again.
        onSave.mockResolvedValue(true);
        fireEvent.click(screen.getByRole('button', { name: 'Use these photos' }));
        await waitFor(() => expect(onClose).toHaveBeenCalled());
    });

    test('a save that throws is treated as refused', async () => {
        const { onClose } = setup({ onSave: jest.fn().mockRejectedValue(new Error('boom')) });
        await screen.findByRole('button', { name: /^Photo 00000001:/ });
        fireEvent.click(screen.getByRole('button', { name: 'Use these photos' }));
        expect((await screen.findByRole('alert')).textContent).toContain("weren't saved");
        expect(onClose).not.toHaveBeenCalled();
    });

    test('Save is disabled while saving', async () => {
        const saving = deferred<boolean>();
        const { onClose } = setup({ onSave: jest.fn<Promise<boolean>, [string[]]>(() => saving.promise) });
        await screen.findByRole('button', { name: /^Photo 00000001:/ });
        fireEvent.click(screen.getByRole('button', { name: 'Use these photos' }));
        await waitFor(() =>
            expect((screen.getByRole('button', { name: 'Use these photos' }) as HTMLButtonElement).disabled).toBe(true),
        );
        await act(async () => saving.resolve(true));
        expect(onClose).toHaveBeenCalled();
    });

    test('a synchronous save callback works too', async () => {
        const { onClose, onSave } = setup({ onSave: jest.fn().mockReturnValue(true) });
        await screen.findByRole('button', { name: /^Photo 00000001:/ });
        fireEvent.click(screen.getByRole('button', { name: 'Use these photos' }));
        await waitFor(() => expect(onClose).toHaveBeenCalled());
        expect(onSave).toHaveBeenCalledWith([]);
    });
});

describe('account scope', () => {
    test('warns when the list was saved under another account, and Clear empties it', async () => {
        window.api.getSetting = jest.fn().mockResolvedValue('d'.repeat(32));
        setup({ value: [idOf(1)] });
        const alert = await screen.findByText(/saved under another account/);
        expect(alert).toBeTruthy();
        fireEvent.click(screen.getByRole('button', { name: 'Clear list' }));
        expect(screen.queryByText(/saved under another account/)).toBeNull();
        expect(tile(1).getAttribute('aria-pressed')).toBe('false');
    });

    test('no warning when the list belongs to the signed-in account', async () => {
        window.api.getSetting = jest.fn().mockResolvedValue(MEMBER);
        setup({ value: [idOf(1)] });
        await screen.findByRole('button', { name: /^Photo 00000001:/ });
        expect(screen.queryByText(/saved under another account/)).toBeNull();
    });

    test('no warning when no owner was recorded, or the member is unknown', async () => {
        setup({ value: [idOf(1)] });
        await screen.findByRole('button', { name: /^Photo 00000001:/ });
        expect(screen.queryByText(/saved under another account/)).toBeNull();
    });

    test('no warning for an empty list', async () => {
        window.api.getSetting = jest.fn().mockResolvedValue('d'.repeat(32));
        setup();
        await screen.findByRole('button', { name: /^Photo 00000001:/ });
        expect(screen.queryByText(/saved under another account/)).toBeNull();
    });
});

test('explains how chosen photos are ranked and used', async () => {
    setup();
    expect(screen.getByText(/ranks chosen photos the way it ranks its own picks/)).toBeTruthy();
    await screen.findByRole('button', { name: /^Photo 00000001:/ });
});

test('Escape closes only the chooser when it is open inside another modal', async () => {
    const outerClose = jest.fn();
    const innerClose = jest.fn();
    const tree = (innerOpen: boolean) => (
        <Modal isOpen onClose={outerClose} title="outer">
            <PhotoChooserModal isOpen={innerOpen} onClose={innerClose} value={[]} onSave={jest.fn()} />
        </Modal>
    );
    const { rerender } = render(tree(false));
    // The chooser opens after the settings modal it sits in.
    rerender(tree(true));
    await screen.findByRole('button', { name: /^Photo 00000001:/ });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(innerClose).toHaveBeenCalledTimes(1);
    expect(outerClose).not.toHaveBeenCalled();
    // Once the chooser is gone the outer modal answers again, and the page stays locked until the last one closes.
    rerender(tree(false));
    expect(document.body.style.overflow).toBe('hidden');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(outerClose).toHaveBeenCalledTimes(1);
});
