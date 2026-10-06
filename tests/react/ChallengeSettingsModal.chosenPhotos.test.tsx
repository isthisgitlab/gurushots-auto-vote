/**
 * The per-challenge settings modal gives its chosen-photos input the challenge
 * it edits, so the chooser can say which photos that challenge accepts, and the
 * edit lands in the modal's overrides (saved with the modal's own Save).
 */
import { fireEvent, render, screen, waitFor } from './helpers/test-utils';
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
