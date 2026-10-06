/**
 * The per-challenge settings modal gives its chosen-photos input the challenge
 * it edits, so the chooser can say which photos that challenge accepts, and the
 * edit lands in the modal's overrides (saved with the modal's own Save).
 */
import { act, fireEvent, render, screen, waitFor } from './helpers/test-utils';
import { ChallengeSettingsModal } from '@/components/app/ChallengeSettingsModal';
import { mockApi } from './helpers/setup';
import type { useSettingsSchema } from '@/api/useSettingsSchema';
import { invalid } from '../helpers/invalid';

const PHOTO = `00000001${'a'.repeat(24)}`;

const mockSchemaState: Partial<ReturnType<typeof useSettingsSchema>> = {
    schema: invalid({
        chosenPhotos: {
            type: 'photos',
            default: [],
            perChallenge: true,
            group: 'autoFill',
            label: 'app.chosenPhotos',
            description: 'app.chosenPhotosDesc',
        },
    }),
    defaults: { chosenPhotos: [] },
    groups: [{ id: 'autoFill', label: 'app.groupAutoFill', tier: 'core' }],
    tiers: [{ id: 'core', label: 'app.tierCore' }],
    refetch: jest.fn(),
    loading: false,
};

jest.mock('@/api/useSettingsSchema', () => ({
    useSettingsSchema: () => mockSchemaState,
}));

beforeEach(() => {
    window.api = invalid(mockApi);
    mockApi.getTitleProfile.mockReset().mockResolvedValue(null);
    mockApi.getChallengeOverrides.mockResolvedValue({});
    mockApi.getSetting.mockResolvedValue('');
    mockApi.getLibraryPhotos.mockResolvedValue(
        invalid({
            success: true,
            photos: [{ id: PHOTO, labels: [], allowed: true, message: null, uploadDate: 1 }],
            memberId: 'c'.repeat(32),
            truncated: false,
            allowedKnown: true,
        }),
    );
});

test('the chooser reads the library through the challenge being edited, and the pick becomes an override', async () => {
    render(<ChallengeSettingsModal isOpen onClose={jest.fn()} challengeId="123" challengeTitle="Sea" />);
    fireEvent.click(await screen.findByRole('button', { name: 'app.choosePhotos' }));
    await waitFor(() => expect(mockApi.getLibraryPhotos).toHaveBeenCalledWith('123', undefined));
    fireEvent.click(await screen.findByRole('button', { name: 'app.photoChooserTileLabel' }));
    fireEvent.click(screen.getByRole('button', { name: 'app.photoChooserUse' }));
    // The edit is held in the form until the modal's own Save.
    await waitFor(() => expect(screen.getByText('app.overridden')).toBeTruthy());
    expect(mockApi.replaceChallengeOverrides).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'app.save' }));
    await waitFor(() =>
        expect(mockApi.replaceChallengeOverrides).toHaveBeenCalledWith('123', { chosenPhotos: [PHOTO] }, false),
    );
});

describe('removing every list from the chooser while the modal holds a draft', () => {
    const OTHER = 'd'.repeat(32);

    const removeFromChooser = async () => {
        fireEvent.click(await screen.findByRole('button', { name: 'app.choosePhotos' }));
        // Another account's list: the chooser's notice offers to remove every list.
        fireEvent.click(await screen.findByRole('button', { name: 'app.photoChooserOtherAccountClear' }));
        const confirm = (await screen.findAllByRole('button', { name: 'app.photoChooserOtherAccountClear' })).at(-1)!;
        fireEvent.click(confirm);
        await waitFor(() => expect(mockApi.clearChosenPhotos).toHaveBeenCalledTimes(1));
        // Leave the chooser without choosing anything: its Cancel is the last one in the page.
        fireEvent.click((await screen.findAllByRole('button', { name: 'app.cancel' })).at(-1)!);
    };

    beforeEach(() => {
        mockApi.getChallengeOverrides.mockResolvedValue({ chosenPhotos: [PHOTO] });
        mockApi.getSetting.mockResolvedValue(OTHER);
        mockApi.clearChosenPhotos.mockClear().mockResolvedValue({ success: true, removed: 1 });
        mockApi.replaceChallengeOverrides.mockClear();
    });

    test('saving the modal afterwards does not write the removed list back', async () => {
        render(<ChallengeSettingsModal isOpen onClose={jest.fn()} challengeId="123" challengeTitle="Sea" />);
        await removeFromChooser();
        await waitFor(() => expect(screen.queryByText('app.photoChooserOtherAccount')).toBeNull());
        fireEvent.click(screen.getByRole('button', { name: 'app.save' }));
        // What is written has no chosen list: the removal stands (and the settings layer, seeing no
        // list in the write, never restamps the signed-in account as its owner).
        await waitFor(() => expect(mockApi.replaceChallengeOverrides).toHaveBeenCalledWith('123', {}, false));
    });

    test('without the removal the same save would have carried the list', async () => {
        render(<ChallengeSettingsModal isOpen onClose={jest.fn()} challengeId="123" challengeTitle="Sea" />);
        await screen.findByRole('button', { name: 'app.choosePhotos' });
        fireEvent.click(screen.getByRole('button', { name: 'app.save' }));
        await waitFor(() =>
            expect(mockApi.replaceChallengeOverrides).toHaveBeenCalledWith('123', { chosenPhotos: [PHOTO] }, false),
        );
    });
});

describe('applying a profile that held a list after every list was removed', () => {
    const OTHER = 'd'.repeat(32);

    test('saving does not bring the list back', async () => {
        mockApi.getChallengeOverrides.mockResolvedValue({});
        mockApi.getSetting.mockResolvedValue(OTHER);
        mockApi.getChallengeProfiles.mockResolvedValue({ Mine: { chosenPhotos: [PHOTO] } });
        // Like the backend, the removal empties the stored profile too.
        mockApi.clearChosenPhotos.mockClear().mockImplementation(async () => {
            mockApi.getChallengeProfiles.mockResolvedValue({ Mine: {} });
            return { success: true, removed: 1 };
        });
        mockApi.replaceChallengeOverrides.mockClear();
        mockApi.getChallengeOverrides.mockResolvedValue({ chosenPhotos: [PHOTO] });
        render(<ChallengeSettingsModal isOpen onClose={jest.fn()} challengeId="123" challengeTitle="Sea" />);
        fireEvent.click(await screen.findByRole('button', { name: 'app.choosePhotos' }));
        fireEvent.click(await screen.findByRole('button', { name: 'app.photoChooserOtherAccountClear' }));
        fireEvent.click((await screen.findAllByRole('button', { name: 'app.photoChooserOtherAccountClear' })).at(-1)!);
        await waitFor(() => expect(mockApi.clearChosenPhotos).toHaveBeenCalledTimes(1));
        fireEvent.click((await screen.findAllByRole('button', { name: 'app.cancel' })).at(-1)!);
        // The profile was loaded while the list still existed; Apply must not put it back.
        const select = await screen.findByRole<HTMLSelectElement>('combobox');
        await waitFor(() => expect(select.textContent).toContain('Mine'));
        await act(async () => {
            select.value = 'Mine';
            select.dispatchEvent(new window.Event('change', { bubbles: true }));
        });
        fireEvent.click(await screen.findByRole('button', { name: 'app.applyProfile' }));
        fireEvent.click(screen.getByRole('button', { name: 'app.save' }));
        await waitFor(() => expect(mockApi.replaceChallengeOverrides).toHaveBeenCalledWith('123', {}, true));
    });
});
