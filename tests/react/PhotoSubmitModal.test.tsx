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
    allowedKnown: true,
    ...over,
});

const english = (key: string) =>
    key.startsWith('app.') ? ((app as Record<string, string>)[key.slice(4)] ?? key) : key;

const getLibrary = () => jest.mocked(window.api.getLibraryPhotos);

const tile = (n: number) => screen.getByRole('button', { name: new RegExp(`^Photo ${shortOf(n)}:`) });
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
        await screen.findByRole('button', { name: /^Photo 00000001:/ });
        expect(getLibrary()).toHaveBeenCalledWith(7, undefined);
        expect(screen.getByText('Choose photos to submit')).toBeTruthy();
        expect(countLine().textContent).toBe('0 of 3 open slots picked');
        expect(submitButton().hasAttribute('disabled')).toBe(true);
        expect(submitButton().textContent).toBe('Submit');
    });

    test('picked tiles are not numbered', async () => {
        setup();
        await screen.findByRole('button', { name: /^Photo 00000001:/ });
        fireEvent.click(tile(2));
        expect(tile(2).getAttribute('aria-pressed')).toBe('true');
        expect(tile(2).getAttribute('aria-label')).not.toMatch(/Number/);
        expect(tile(2).querySelector('.badge')).toBeNull();
    });
});

describe('picking and submitting', () => {
    test('Submit names the count and sends the picked ids in the order picked', async () => {
        const { props } = setup();
        await screen.findByRole('button', { name: /^Photo 00000001:/ });
        fireEvent.click(tile(3));
        fireEvent.click(tile(1));
        expect(submitButton().textContent).toBe('Submit 2');
        expect(countLine().textContent).toBe('2 of 3 open slots picked');
        fireEvent.click(submitButton());
        await waitFor(() => expect(props.onSubmit).toHaveBeenCalledWith([idOf(3), idOf(1)]));
        // Done: the card closes it, and nothing is read again.
        expect(getLibrary()).toHaveBeenCalledTimes(1);
    });

    test('a pick can be taken back', async () => {
        setup();
        await screen.findByRole('button', { name: /^Photo 00000001:/ });
        fireEvent.click(tile(1));
        fireEvent.click(tile(1));
        expect(tile(1).getAttribute('aria-pressed')).toBe('false');
        expect(submitButton().hasAttribute('disabled')).toBe(true);
    });

    test('at the cap the other tiles are held and say the open slots are all picked', async () => {
        setup({ max: 2 });
        await screen.findByRole('button', { name: /^Photo 00000001:/ });
        fireEvent.click(tile(1));
        fireEvent.click(tile(2));
        expect(tile(3).getAttribute('aria-disabled')).toBe('true');
        expect(tile(3).textContent).toContain('All open slots picked');
        fireEvent.click(tile(3));
        expect(countLine().textContent).toBe('2 of 2 open slots picked');
    });

    test('with one open slot a tap swaps the pick instead of being refused', async () => {
        const { props } = setup({ max: 1 });
        await screen.findByRole('button', { name: /^Photo 00000001:/ });
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
        await screen.findByRole('button', { name: /^Photo 00000001:/ });
        fireEvent.change(screen.getByLabelText('Search your photos by tag'), { target: { value: 'sun' } });
        fireEvent.click(screen.getByRole('button', { name: 'Search' }));
        await waitFor(() => expect(getLibrary()).toHaveBeenLastCalledWith(7, 'sun'));
        await screen.findByRole('button', { name: /^Photo 00000001:/ });
        fireEvent.click(tile(2));
        fireEvent.click(submitButton());
        await waitFor(() => expect(getLibrary()).toHaveBeenCalledTimes(3));
        expect(getLibrary()).toHaveBeenLastCalledWith(7, 'sun');
        await screen.findByRole('button', { name: /^Photo 00000001:/ });
        expect(tile(2).getAttribute('aria-pressed')).toBe('true');
    });

    test('a failure that changed nothing does not read the listing again', async () => {
        const onSubmit = jest.fn<Promise<PickOutcome>, [string[]]>().mockResolvedValue('failed');
        setup({ onSubmit });
        await screen.findByRole('button', { name: /^Photo 00000001:/ });
        fireEvent.click(tile(1));
        fireEvent.click(submitButton());
        await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
        await act(async () => undefined);
        expect(getLibrary()).toHaveBeenCalledTimes(1);
    });

    test('a search that no longer lists a picked photo keeps the pick', async () => {
        const { props } = setup();
        await screen.findByRole('button', { name: /^Photo 00000001:/ });
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

describe('failure text', () => {
    test('shows the translated error inline as an alert', async () => {
        setup({ error: 'The photos were not submitted. Pick other photos.' });
        await screen.findByRole('button', { name: /^Photo 00000001:/ });
        expect(screen.getByRole('alert').textContent).toBe('The photos were not submitted. Pick other photos.');
    });
});

describe('the cap changing while open', () => {
    test('a cap below the picks says so and holds Submit until enough are taken back', async () => {
        const { update } = setup({ max: 3 });
        await screen.findByRole('button', { name: /^Photo 00000001:/ });
        fireEvent.click(tile(1));
        fireEvent.click(tile(2));
        fireEvent.click(tile(3));
        update({ max: 2 });
        expect(countLine().textContent).toBe('3 picked, but only 2 slots are open. Remove some to submit.');
        expect(submitButton().hasAttribute('disabled')).toBe(true);
        // Picked tiles stay removable; unpicked ones are held.
        expect(tile(4).getAttribute('aria-disabled')).toBe('true');
        fireEvent.click(tile(3));
        expect(submitButton().hasAttribute('disabled')).toBe(false);
        expect(submitButton().textContent).toBe('Submit 2');
    });

    test('no open slots left: says so with Close only, whatever was picked', async () => {
        const onClose = jest.fn();
        const { update } = setup({ max: 2, onClose });
        await screen.findByRole('button', { name: /^Photo 00000001:/ });
        fireEvent.click(tile(1));
        update({ max: 0 });
        expect(screen.getByText(/^No open slots left/)).toBeTruthy();
        expect(screen.queryByRole('button', { name: /^Submit/ })).toBeNull();
        expect(screen.queryByRole('button', { name: /^Photo / })).toBeNull();
        expect(screen.queryByLabelText('Search your photos by tag')).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: 'Close' }));
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    test('with no open slots the failure that ended them still shows', async () => {
        const { update } = setup({ max: 1 });
        await screen.findByRole('button', { name: /^Photo 00000001:/ });
        update({ max: 0, error: 'The photos may have been submitted.' });
        expect(screen.getByRole('alert').textContent).toBe('The photos may have been submitted.');
    });

    test('with no open slots a submit in flight keeps Close held', async () => {
        const { update } = setup({ max: 1 });
        await screen.findByRole('button', { name: /^Photo 00000001:/ });
        update({ max: 0, submitting: true });
        expect(screen.getAllByRole('button', { name: 'Close' }).every((b) => b.hasAttribute('disabled'))).toBe(true);
    });
});

describe('closing', () => {
    test('Cancel and Escape close it while idle', async () => {
        const onClose = jest.fn();
        setup({ onClose });
        await screen.findByRole('button', { name: /^Photo 00000001:/ });
        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
        expect(onClose).toHaveBeenCalledTimes(1);
        fireEvent.keyDown(document, { key: 'Escape' });
        expect(onClose).toHaveBeenCalledTimes(2);
    });

    test('while a submit is in flight nothing closes it: no Cancel, no Escape, no ✕, and Submit shows busy', async () => {
        const onClose = jest.fn();
        setup({ onClose, submitting: true });
        await screen.findByRole('button', { name: /^Photo 00000001:/ });
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
        await screen.findByRole('button', { name: /^Photo 00000001:/ });
        expect(getLibrary()).toHaveBeenCalledTimes(2);
    });

    test('a superseded answer offers Retry too', async () => {
        getLibrary().mockResolvedValueOnce(invalid({ success: false, error: 'superseded' }));
        setup();
        await screen.findByRole('button', { name: 'Retry' });
    });
});
