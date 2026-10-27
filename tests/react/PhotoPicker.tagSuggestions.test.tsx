/**
 * The picker toolbar's search box: the tag suggestions under it — they appear
 * from the search-photo-tags reply, a click searches exactly that tag once and
 * puts focus back in the box, a tag equal to the text is hidden (trimmed,
 * case-insensitive), the live line fills and empties by its own rule, and at
 * most 8 buttons are shown. The real debounce runs on real timers.
 */

import { act, fireEvent, render, screen } from './helpers/test-utils';
import { PhotoPickerToolbar } from '@/components/app/PhotoPicker';
import { mockApi } from './helpers/setup';
import { invalid } from '../helpers/invalid';
import type { usePhotoPicker } from '@/hooks/usePhotoPicker';

type Picker = ReturnType<typeof usePhotoPicker>;

// A picker fixture for the direct toolbar render: the fields the toolbar and its stats
// controls read (Auto and the strip are not shown at canSuggest: false).
const toolbarPicker = (over: Partial<Picker> = {}): Picker =>
    invalid<Picker>({
        state: { status: 'ready', listing: { photos: [] }, order: 'votes' },
        revalidating: false,
        recheckFailed: false,
        loadingMore: false,
        loadPhotosReading: false,
        searchKey: 0,
        search: jest.fn<void, [string]>(),
        loadPhotos: jest.fn<void, []>(),
        suggesting: false,
        suggested: null,
        shownIds: [],
        shownCount: null,
        sortBy: 'library',
        setSortBy: jest.fn(),
        showStats: false,
        setShowStats: jest.fn(),
        statsProgress: null,
        statsRead: null,
        statsMissing: [],
        retryStats: jest.fn<number, []>(() => 1),
        order: 'votes',
        setOrder: jest.fn(),
        ...over,
    });

const renderToolbar = (over: Partial<Picker> = {}) => {
    const search = jest.fn<void, [string]>();
    render(
        <PhotoPickerToolbar
            picker={toolbarPicker({ search, ...over })}
            selected={[]}
            canSuggest={false}
            held={false}
            locked={false}
            lockedKey="app.pickLockedHint"
            fullKey="app.pickFullHint"
            helpKey="app.photoChooserHelpAuto"
            autoHelpKey="app.pickAutoHelp"
            autoRunningKey="app.pickAutoRunning"
            atCap={false}
            addPolicy="append"
            onAdd={jest.fn()}
            onToggle={jest.fn()}
        />,
    );
    return { search };
};

const type = async (text: string) => {
    fireEvent.change(screen.getByPlaceholderText('app.photoChooserSearchPlaceholder'), { target: { value: text } });
    // The 300 ms debounce, real: wait past it, then flush the reply and the passive effects.
    await act(() => new Promise((resolve) => setTimeout(resolve, 350)));
};

const searchBox = () => screen.getByPlaceholderText('app.photoChooserSearchPlaceholder') as HTMLInputElement;
// The search form's own live line (the stats status region lives outside it).
const liveLine = () =>
    screen.getByPlaceholderText('app.photoChooserSearchPlaceholder').closest('form')?.querySelector('p[aria-live]');

const answerTags = (tags: string[]) => mockApi.searchPhotoTags.mockResolvedValue({ success: true, tags });

describe('the search box tag suggestions', () => {
    beforeEach(() => {
        mockApi.searchPhotoTags.mockResolvedValue({ success: true, tags: [] });
    });

    test('suggestions appear under the box, labelled, once the reply lands', async () => {
        answerTags(['staircase', 'flower']);
        renderToolbar();
        expect(screen.queryByRole('group')).toBeNull();
        await type('flo');
        expect(mockApi.searchPhotoTags).toHaveBeenCalledWith('flo');
        const group = screen.getByRole('group', { name: 'app.photoChooserTagMatches' });
        expect(group.querySelector('span')?.textContent).toBe('app.photoChooserTagMatches');
        expect(screen.getByRole('button', { name: 'staircase' })).toBeTruthy();
        expect(screen.getByRole('button', { name: 'flower' })).toBeTruthy();
    });

    test('the row is already there before the reply lands, so the grid does not jump', async () => {
        answerTags(['staircase']);
        renderToolbar();
        fireEvent.change(screen.getByPlaceholderText('app.photoChooserSearchPlaceholder'), {
            target: { value: 'flo' },
        });
        // The row keeps its height before anything lands; the label waits for tags.
        expect(screen.getByRole('group', { name: 'app.photoChooserTagMatches' })).toBeTruthy();
        expect(screen.queryByText('app.photoChooserTagMatches')).toBeNull();
        await act(() => new Promise((resolve) => setTimeout(resolve, 350)));
        // Once tags land, the label names the row.
        expect(screen.getByText('app.photoChooserTagMatches')).toBeTruthy();
        // A zero-tag reply takes it away again.
        mockApi.searchPhotoTags.mockResolvedValue({ success: true, tags: [] });
        await type('zzz');
        expect(screen.queryByText('app.photoChooserTagMatches')).toBeNull();
    });

    test('a click searches exactly that tag once and puts focus back in the box', async () => {
        answerTags(['staircase', 'flower']);
        const { search } = renderToolbar();
        await type('flo');
        const box = searchBox();
        box.blur();
        fireEvent.click(screen.getByRole('button', { name: 'flower' }));
        expect(search).toHaveBeenCalledTimes(1);
        expect(search).toHaveBeenCalledWith('flower');
        expect(box.value).toBe('flower');
        expect(document.activeElement).toBe(box);
    });

    test('a tag equal to the text is hidden, trimmed and case-insensitively; a different text shows it', async () => {
        answerTags(['staircase']);
        renderToolbar();
        await type('staircase');
        expect(screen.queryByRole('button', { name: 'staircase' })).toBeNull();
        await type(' Staircase ');
        expect(screen.queryByRole('button', { name: 'staircase' })).toBeNull();
        await type('stair');
        expect(screen.getByRole('button', { name: 'staircase' })).toBeTruthy();
    });

    describe('the live line', () => {
        test('fills on the first reply with tags and stays filled while typing on', async () => {
            answerTags(['staircase']);
            renderToolbar();
            await type('flo');
            expect(liveLine()?.textContent).toBe('app.photoChooserTagMatchesFound');
            // Typing on from "flo" to "flow" leaves its text unchanged before and after the new reply.
            fireEvent.change(searchBox(), { target: { value: 'flow' } });
            expect(liveLine()?.textContent).toBe('app.photoChooserTagMatchesFound');
            await act(() => new Promise((resolve) => setTimeout(resolve, 350)));
            expect(liveLine()?.textContent).toBe('app.photoChooserTagMatchesFound');
        });

        test('empties below the minimum and on a zero-tag reply', async () => {
            answerTags([]);
            renderToolbar();
            await type('flo');
            expect(liveLine()?.textContent).toBe('');
            await type('zz');
            expect(liveLine()?.textContent).toBe('');
        });

        test('a zero-tag reply empties it again', async () => {
            answerTags(['staircase']);
            renderToolbar();
            await type('flo');
            expect(liveLine()?.textContent).toBe('app.photoChooserTagMatchesFound');
            mockApi.searchPhotoTags.mockResolvedValue({ success: true, tags: [] });
            await type('zzz');
            expect(liveLine()?.textContent).toBe('');
        });
    });

    test('at most 8 buttons from a 25-tag reply', async () => {
        answerTags(Array.from({ length: 25 }, (_, i) => `tag${i}`));
        renderToolbar();
        await type('tag');
        expect(screen.getAllByRole('group')[0].querySelectorAll('button')).toHaveLength(8);
        expect(screen.getByRole('button', { name: 'tag7' })).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'tag8' })).toBeNull();
    });
});
