/**
 * The settings modal's Profiles section: pick a saved profile and edit its
 * values with the tab's own Save, the switch-away confirm on an unsaved draft,
 * and Discard reseeding from a fresh read.
 */

import { act, render, screen, waitFor, fireEvent, within } from './helpers/test-utils';
import { ProfilesSection } from '@/components/app/ProfilesSection';
import { SettingsNavProvider } from '@/contexts/SettingsNavContext';
import { mockApi } from './helpers/setup';
import { invalid } from '../helpers/invalid';

import type { SettingsNav } from '@/contexts/SettingsNavContext';
import type { SettingsTabId } from '@/utils/groupSettings';
import type { RendererSchema } from '../../src/ts/types/settingsEditor';
import type { ChallengeValues } from '../../src/ts/types/settings';

// `extra` sits in a group whose tier is unknown: it renders in the trailing
// unlabelled band and stands in for a stored key with no cell of its own.
const SCHEMA = invalid<RendererSchema>({
    exposure: {
        type: 'number',
        perChallenge: true,
        group: 'g',
        default: 70,
        min: 0,
        max: 100,
        label: 'app.exposure',
        description: 'Exposure',
    },
    manualPhotosOnly: {
        type: 'boolean',
        perChallenge: true,
        group: 'g',
        default: false,
        label: 'app.manualPhotosOnly',
        description: 'Manual only',
    },
    extra: {
        type: 'boolean',
        perChallenge: true,
        group: 'stray',
        default: false,
        label: 'app.extra',
        description: 'Extra',
    },
});
const GROUPS = [
    { id: 'g', label: 'app.groupMain', tier: 'core' },
    { id: 'stray', label: 'app.groupStray', tier: 'nowhere' },
];
const TIERS = [{ id: 'core', label: 'app.tierCore' }];
const DEFAULTS = { exposure: 70, manualPhotosOnly: false, extra: false };

const TACTIC: ChallengeValues = { exposure: 80, extra: true };
// The exact built-in bundle, so an unedited copy reads as built-in.
const INTENT: ChallengeValues = {
    exposure: 100,
    exposureTarget: 0,
    autoBoost: false,
    useTurbo: false,
    autoTurbo: false,
    autoSubmit: true,
};

const onDirtyChange = jest.fn();

const withSchema = () =>
    mockApi.getSettingsSchema.mockResolvedValue(
        invalid({ schema: SCHEMA, defaults: DEFAULTS, groups: GROUPS, tiers: TIERS }),
    );
const withProfiles = (profiles: Record<string, ChallengeValues>) =>
    mockApi.getChallengeProfiles.mockReset().mockResolvedValue(invalid(profiles));

// The section renders inside the modal's tab panel; give it a navigation that shows it.
const shownNav = (active: SettingsTabId): SettingsNav => ({
    query: '',
    namesOnly: false,
    isShown: () => true,
    active,
    selectionSeq: 0,
    select: () => undefined,
    setQuery: () => undefined,
    reveal: () => undefined,
    reset: () => undefined,
});

const renderSection = async (
    profiles: Record<string, ChallengeValues> = { tactic: TACTIC, 'Just Participate': INTENT },
) => {
    withSchema();
    withProfiles(profiles);
    render(
        <SettingsNavProvider value={shownNav('profiles')}>
            <ProfilesSection isOpen={true} onDirtyChange={onDirtyChange} />
        </SettingsNavProvider>,
    );
    await waitFor(() => expect(screen.queryByText('common.loading')).toBeNull());
};

const selectEl = () => screen.getByRole<HTMLSelectElement>('combobox', { name: 'app.challengeProfiles' });
const exposureInput = () => screen.getByLabelText<HTMLInputElement>(/^app\.exposure/);
const saveButton = () => screen.getByRole<HTMLButtonElement>('button', { name: 'app.saveProfile' });
const discardButton = () => screen.getByRole<HTMLButtonElement>('button', { name: 'app.discardProfileChanges' });

// A <select>'s onChange stays a native 'change' listener under preact/compat
// (see ChallengeProfilesBar.test.tsx), so dispatch the real event.
const changeSelect = (sel: HTMLSelectElement, value: string) =>
    act(() => {
        sel.value = value;
        sel.dispatchEvent(new window.Event('change', { bubbles: true }));
    });

beforeEach(() => {
    window.api = invalid(mockApi);
    onDirtyChange.mockReset();
    mockApi.saveChallengeProfile.mockReset().mockResolvedValue(true);
});

describe('ProfilesSection — the picker', () => {
    test('the empty state names where profiles are made, and nothing is editable', async () => {
        await renderSection({});
        expect(screen.getByText('app.profilesEmptyHint')).toBeTruthy();
        expect(selectEl().value).toBe('');
        expect(selectEl().textContent).toContain('app.noProfiles');
        expect(screen.queryByRole('button', { name: 'app.saveProfile' })).toBeNull();
    });

    test('nothing is selected on open; the list carries the ★ marker and the counts', async () => {
        await renderSection();
        expect(selectEl().value).toBe('');
        const options = Array.from(selectEl().options).map((option) => option.textContent);
        expect(options).toEqual(['—', '★ app.intentJustParticipate (6)', 'tactic (2)']);
        expect(screen.queryByRole('button', { name: 'app.saveProfile' })).toBeNull();
    });

    test('a failed load shows the alert and no editor', async () => {
        withSchema();
        mockApi.getChallengeProfiles.mockReset().mockRejectedValue(new Error('ipc down'));
        render(
            <SettingsNavProvider value={shownNav('profiles')}>
                <ProfilesSection isOpen={true} onDirtyChange={onDirtyChange} />
            </SettingsNavProvider>,
        );
        await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('app.profilesLoadError'));
        expect(screen.queryByRole('combobox')).toBeNull();
    });
});

describe('ProfilesSection — editing a picked profile', () => {
    test('the fields show the picked values with the Set in profile badge; buttons start disabled', async () => {
        await renderSection();
        changeSelect(selectEl(), 'tactic');
        expect(exposureInput().value).toBe('80');
        // Every cell of the picked profile's map carries the badge.
        expect(screen.getAllByText('app.setInProfile').length).toBeGreaterThan(0);
        expect(saveButton().disabled).toBe(true);
        expect(discardButton().disabled).toBe(true);
    });

    test('an edit enables the buttons and reports the draft as unsaved', async () => {
        await renderSection();
        changeSelect(selectEl(), 'tactic');
        onDirtyChange.mockClear();
        fireEvent.change(exposureInput(), { target: { value: '90' } });
        expect(saveButton().disabled).toBe(false);
        expect(discardButton().disabled).toBe(false);
        await waitFor(() => expect(onDirtyChange).toHaveBeenCalledWith(true));
    });

    test('a save writes the whole map, lands the draft and shows the live message', async () => {
        await renderSection();
        changeSelect(selectEl(), 'tactic');
        fireEvent.change(exposureInput(), { target: { value: '90' } });
        fireEvent.click(saveButton());

        await waitFor(() =>
            expect(mockApi.saveChallengeProfile).toHaveBeenCalledWith('tactic', { exposure: 90, extra: true }),
        );
        expect(await screen.findByText('app.profileSaved')).toBeTruthy();
        await waitFor(() => expect(saveButton().disabled).toBe(true));
        await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false));
    });

    test('the save button shows the busy spinner while the write is out, and the select is disabled', async () => {
        let resolveSave!: (value: boolean) => void;
        mockApi.saveChallengeProfile.mockReturnValue(
            invalid(
                new Promise<boolean>((resolve) => {
                    resolveSave = resolve;
                }),
            ),
        );
        await renderSection();
        changeSelect(selectEl(), 'tactic');
        fireEvent.change(exposureInput(), { target: { value: '90' } });
        fireEvent.click(saveButton());
        expect(saveButton().getAttribute('aria-busy')).toBe('true');
        // A switch during a save would race the write: the select is disabled too.
        expect(selectEl().disabled).toBe(true);

        resolveSave(true);
        await screen.findByText('app.profileSaved');
        expect(saveButton().getAttribute('aria-busy')).toBe('false');
        expect(selectEl().disabled).toBe(false);
    });

    test('the select takes focus after a landed save drops the disabled buttons', async () => {
        let resolveSave!: (value: boolean) => void;
        mockApi.saveChallengeProfile.mockReturnValue(
            invalid(
                new Promise<boolean>((resolve) => {
                    resolveSave = resolve;
                }),
            ),
        );
        await renderSection();
        changeSelect(selectEl(), 'tactic');
        fireEvent.change(exposureInput(), { target: { value: '90' } });
        fireEvent.click(saveButton());

        await act(async () => {
            resolveSave(true);
        });
        await waitFor(() => expect(document.activeElement).toBe(selectEl()));
        expect(screen.getByText('app.profileSaved')).toBeTruthy();
    });

    test('after a refused save, focus lands on the re-enabled Save profile button', async () => {
        mockApi.saveChallengeProfile.mockResolvedValue(false);
        await renderSection();
        changeSelect(selectEl(), 'tactic');
        fireEvent.change(exposureInput(), { target: { value: '90' } });
        fireEvent.click(saveButton());

        await waitFor(() => expect(document.activeElement).toBe(saveButton()));
        expect(screen.getByText('app.profileEditSaveError')).toBeTruthy();
        // The draft is still dirty: the button took the focus back enabled.
        expect(saveButton().disabled).toBe(false);
    });

    test('a refused save shows the error alert and keeps the draft', async () => {
        mockApi.saveChallengeProfile.mockResolvedValue(false);
        await renderSection();
        changeSelect(selectEl(), 'tactic');
        fireEvent.change(exposureInput(), { target: { value: '90' } });
        fireEvent.click(saveButton());

        expect(await screen.findByRole('alert')).toBeTruthy();
        expect(screen.getByText('app.profileEditSaveError')).toBeTruthy();
        expect(saveButton().disabled).toBe(false);
    });

    test('a landed save note clears on the next edit', async () => {
        await renderSection();
        changeSelect(selectEl(), 'tactic');
        fireEvent.change(exposureInput(), { target: { value: '90' } });
        fireEvent.click(saveButton());
        await screen.findByText('app.profileSaved');

        fireEvent.change(exposureInput(), { target: { value: '95' } });
        expect(screen.queryByText('app.profileSaved')).toBeNull();
    });

    test('a switch clears the landed save note', async () => {
        await renderSection();
        changeSelect(selectEl(), 'tactic');
        fireEvent.change(exposureInput(), { target: { value: '90' } });
        fireEvent.click(saveButton());
        await screen.findByText('app.profileSaved');

        // The landed save left no draft: the switch needs no confirm.
        changeSelect(selectEl(), 'Just Participate');
        expect(screen.queryByText('app.profileSaved')).toBeNull();
    });

    test('a switch clears the save error', async () => {
        mockApi.saveChallengeProfile.mockResolvedValue(false);
        await renderSection();
        changeSelect(selectEl(), 'tactic');
        fireEvent.change(exposureInput(), { target: { value: '90' } });
        fireEvent.click(saveButton());
        await screen.findByText('app.profileEditSaveError');

        // The refused draft is dirty, so the switch asks first; the confirm
        // switches and the stale error goes with it.
        changeSelect(selectEl(), 'Just Participate');
        fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'app.discardProfileChanges' }));
        await waitFor(() => expect(exposureInput().value).toBe('100'));
        expect(screen.queryByRole('alert')).toBeNull();
        expect(screen.queryByText('app.profileSaved')).toBeNull();
    });

    test('unchecking an on-only key clears it, so the save never stores its false', async () => {
        withProfiles({ restricted: { exposure: 80, manualPhotosOnly: true } });
        await renderSection({ restricted: { exposure: 80, manualPhotosOnly: true } });
        changeSelect(selectEl(), 'restricted');
        fireEvent.click(screen.getByLabelText<HTMLInputElement>(/^app\.manualPhotosOnly/));
        expect(screen.getByLabelText<HTMLInputElement>(/^app\.manualPhotosOnly/).checked).toBe(false);

        fireEvent.click(saveButton());
        await waitFor(() => expect(mockApi.saveChallengeProfile).toHaveBeenCalledWith('restricted', { exposure: 80 }));
    });

    test('discard reseeds the picked profile from a fresh read', async () => {
        await renderSection();
        changeSelect(selectEl(), 'tactic');
        fireEvent.change(exposureInput(), { target: { value: '90' } });
        withProfiles({ tactic: { exposure: 85, extra: true } });

        fireEvent.click(discardButton());
        await waitFor(() => expect(exposureInput().value).toBe('85'));
        expect(saveButton().disabled).toBe(true);
        expect(mockApi.saveChallengeProfile).not.toHaveBeenCalled();
    });

    test('the editor stays mounted during the discard refetch, and the select takes focus back', async () => {
        await renderSection();
        changeSelect(selectEl(), 'tactic');
        fireEvent.change(exposureInput(), { target: { value: '90' } });
        let resolveRead!: (value: unknown) => void;
        mockApi.getChallengeProfiles.mockReturnValue(
            invalid(
                new Promise((resolve) => {
                    resolveRead = resolve;
                }),
            ),
        );

        fireEvent.click(discardButton());
        // The refetch must not swap the editor for the loading spinner, and a
        // save landing mid-read would show stale values as saved: the actions
        // and the select wait for the read.
        expect(screen.queryByText('common.loading')).toBeNull();
        expect(saveButton().disabled).toBe(true);
        expect(discardButton().disabled).toBe(true);
        expect(selectEl().disabled).toBe(true);
        // Focus waits for the read: the disabled select has not taken it yet.
        expect(document.activeElement).not.toBe(selectEl());

        await act(async () => {
            resolveRead({ tactic: { exposure: 85, extra: true } });
        });
        await waitFor(() => expect(document.activeElement).toBe(selectEl()));
        expect(exposureInput().value).toBe('85');
        expect(saveButton().disabled).toBe(true);
    });

    test('a discarded read that no longer holds the picked profile hides the fields', async () => {
        await renderSection();
        changeSelect(selectEl(), 'tactic');
        fireEvent.change(exposureInput(), { target: { value: '90' } });
        withProfiles({});

        fireEvent.click(discardButton());
        await waitFor(() => expect(screen.queryByRole('button', { name: 'app.saveProfile' })).toBeNull());
        // The pick no longer names a stored profile, so the select falls back
        // to its placeholder option.
        expect(selectEl().value).toBe('');
        expect(onDirtyChange).toHaveBeenLastCalledWith(false);
    });
});

describe('ProfilesSection — the switch confirm', () => {
    test('a clean switch needs no confirm and shows the other profile', async () => {
        await renderSection();
        changeSelect(selectEl(), 'tactic');
        changeSelect(selectEl(), 'Just Participate');
        expect(screen.queryByText('app.profileSwitchTitle')).toBeNull();
        expect(exposureInput().value).toBe('100');
    });

    test('switching with an unsaved draft asks; the confirm switches and discards', async () => {
        await renderSection();
        changeSelect(selectEl(), 'tactic');
        fireEvent.change(exposureInput(), { target: { value: '90' } });
        changeSelect(selectEl(), 'Just Participate');

        expect(screen.getByText('app.profileSwitchTitle')).toBeTruthy();
        expect(screen.getByText('app.profileSwitchText')).toBeTruthy();
        // The confirm shares its label with the tab's own Discard button.
        fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'app.discardProfileChanges' }));

        await waitFor(() => expect(exposureInput().value).toBe('100'));
        expect(screen.queryByText('app.profileSwitchTitle')).toBeNull();
    });

    test('Keep editing puts the select back on the current profile and refocuses it', async () => {
        await renderSection();
        changeSelect(selectEl(), 'tactic');
        fireEvent.change(exposureInput(), { target: { value: '90' } });
        changeSelect(selectEl(), 'Just Participate');
        fireEvent.click(screen.getByRole('button', { name: 'app.settingsKeepEditing' }));

        expect(screen.queryByText('app.profileSwitchTitle')).toBeNull();
        expect(selectEl().value).toBe('tactic');
        expect(document.activeElement).toBe(selectEl());
        expect(exposureInput().value).toBe('90');
    });
});

describe('ProfilesSection — the schema bands', () => {
    test('each band gets a heading, the untitled trailing band none, and a stored key with no cell is kept', async () => {
        await renderSection();
        changeSelect(selectEl(), 'tactic');
        // The panel's sr-only h4, the core band's heading and the two groups'
        // own headings — the trailing unlabelled band adds no heading of its own.
        const headingNames = () => screen.getAllByRole('heading').map((heading) => heading.textContent);
        expect(headingNames()).toEqual(['app.challengeProfiles', 'app.tierCore', 'app.groupMain', 'app.groupStray']);
        // The no-cell key renders in the trailing band and is saved with the rest.
        expect(screen.getByLabelText<HTMLInputElement>(/^app\.extra/).checked).toBe(true);
    });

    test('a ★ preset shows the built-in badge and description', async () => {
        await renderSection();
        changeSelect(selectEl(), 'Just Participate');
        expect(screen.getByText('app.intentBuiltIn')).toBeTruthy();
        expect(screen.getByText('app.intentJustParticipateDesc')).toBeTruthy();
    });

    test('a ★ preset whose stored copy was edited shows the modified badge', async () => {
        await renderSection({ tactic: TACTIC, 'Just Participate': { ...INTENT, exposure: 90 } });
        changeSelect(selectEl(), 'Just Participate');
        expect(screen.getByText('app.intentModified')).toBeTruthy();
        expect(screen.queryByText('app.intentBuiltIn')).toBeNull();
    });
});
