/**
 * ChallengeProfilesBar behavior:
 *   - Apply hands the selected profile's values to onApply and shows the
 *     applied hint (persisting stays with the modal's own Save).
 *   - Save passes the modal's current sparse overrides; client-side name
 *     pre-validation surfaces specific errors using the IPC-provided limits.
 *   - Delete and same-name overwrite are two-step confirm buttons.
 */
import { render, screen, fireEvent, waitFor, act } from './helpers/test-utils';
import { ChallengeProfilesBar } from '@/components/app/ChallengeProfilesBar';
import { mockApi } from './helpers/setup';

beforeEach(() => {
    window.api = mockApi;
    jest.clearAllMocks();
    mockApi.getChallengeProfiles.mockResolvedValue({});
    mockApi.saveChallengeProfile.mockResolvedValue(true);
    mockApi.deleteChallengeProfile.mockResolvedValue(true);
});

const LIMITS = { maxChallengeProfiles: 50, maxProfileNameLength: 60 };

const renderBar = (props = {}) =>
    render(<ChallengeProfilesBar overrides={{}} onApply={jest.fn()} profileLimits={LIMITS} {...props} />);

const selectEl = () => screen.getByRole('combobox');

// @testing-library/preact renames fireEvent.change → an 'input' event once it
// detects preact/compat, but compat's onChange→onInput rewrite covers only
// input/textarea — a <select>'s onChange stays a native 'change' listener, so
// the renamed event misses it. Dispatch the real change event directly.
const changeSelect = (sel, value) => {
    sel.value = value;
    sel.dispatchEvent(new window.Event('change', { bubbles: true }));
};
const applyButton = () => screen.getByRole('button', { name: 'app.applyProfile' });
const saveButton = () => screen.getByRole('button', { name: /app\.(saveAsProfile|confirmOverwrite)/ });
const deleteButton = () => screen.getByRole('button', { name: /app\.(deleteProfile|confirmDelete)/ });
const nameInput = () => screen.getByPlaceholderText('app.profileNamePlaceholder');

describe('ChallengeProfilesBar', () => {
    test('lists profiles with their override counts', async () => {
        mockApi.getChallengeProfiles.mockResolvedValue({
            '2-pic tactic': { exposure: 80, autoFill: true },
            empty: {},
        });
        renderBar();

        await waitFor(() => {
            expect(document.body.textContent).toContain('2-pic tactic (2)');
        });
        expect(document.body.textContent).toContain('empty (0)');
    });

    test('Apply hands the profile values to onApply and shows the applied hint', async () => {
        mockApi.getChallengeProfiles.mockResolvedValue({ tactic: { exposure: 80 } });
        const onApply = jest.fn();
        renderBar({ onApply });

        await waitFor(() => {
            expect(document.body.textContent).toContain('tactic (1)');
        });
        await act(async () => {
            changeSelect(selectEl(), 'tactic');
        });
        await act(async () => {
            fireEvent.click(applyButton());
        });

        expect(onApply).toHaveBeenCalledWith({ exposure: 80 });
        expect(document.body.textContent).toContain('app.profileAppliedHint');
        // Nothing persisted from Apply itself.
        expect(mockApi.saveChallengeProfile).not.toHaveBeenCalled();
        expect(mockApi.applyChallengeProfile).not.toHaveBeenCalled();
    });

    test('Save passes the current sparse overrides under the typed name', async () => {
        const overrides = { exposure: 70, autoFill: true };
        renderBar({ overrides });

        fireEvent.change(nameInput(), { target: { value: '  3-pic tactic  ' } });
        await act(async () => {
            fireEvent.click(saveButton());
        });

        expect(mockApi.saveChallengeProfile).toHaveBeenCalledWith('3-pic tactic', overrides);
    });

    test('empty name shows a specific error and never hits IPC', async () => {
        renderBar();
        await act(async () => {
            fireEvent.click(saveButton());
        });
        expect(document.body.textContent).toContain('app.profileNameRequired');
        expect(mockApi.saveChallengeProfile).not.toHaveBeenCalled();
    });

    test('over-long name shows the length error with the IPC-provided limit', async () => {
        renderBar();
        fireEvent.change(nameInput(), { target: { value: 'x'.repeat(61) } });
        await act(async () => {
            fireEvent.click(saveButton());
        });
        expect(document.body.textContent).toContain('app.profileNameTooLong');
        expect(mockApi.saveChallengeProfile).not.toHaveBeenCalled();
    });

    test('profile cap blocks a NEW name with a specific error', async () => {
        const atCap = {};
        for (let i = 0; i < 50; i++) atCap[`p${i}`] = {};
        mockApi.getChallengeProfiles.mockResolvedValue(atCap);
        renderBar();
        await waitFor(() => {
            expect(document.body.textContent).toContain('p0 (0)');
        });

        fireEvent.change(nameInput(), { target: { value: 'one-too-many' } });
        await act(async () => {
            fireEvent.click(saveButton());
        });
        expect(document.body.textContent).toContain('app.profileLimitReached');
        expect(mockApi.saveChallengeProfile).not.toHaveBeenCalled();
    });

    test('existing name (case-insensitive) requires a second confirming click to overwrite', async () => {
        mockApi.getChallengeProfiles.mockResolvedValue({ Tactic: { exposure: 80 } });
        renderBar({ overrides: { exposure: 60 } });
        await waitFor(() => {
            expect(document.body.textContent).toContain('Tactic (1)');
        });

        fireEvent.change(nameInput(), { target: { value: 'tactic' } });
        await act(async () => {
            fireEvent.click(saveButton());
        });
        // First click arms the overwrite confirm — nothing saved yet.
        expect(mockApi.saveChallengeProfile).not.toHaveBeenCalled();
        expect(document.body.textContent).toContain('app.confirmOverwrite');

        await act(async () => {
            fireEvent.click(saveButton());
        });
        expect(mockApi.saveChallengeProfile).toHaveBeenCalledWith('tactic', { exposure: 60 });
    });

    test('facade save rejection shows the generic error', async () => {
        mockApi.saveChallengeProfile.mockResolvedValue(false);
        renderBar();
        fireEvent.change(nameInput(), { target: { value: 'p' } });
        await act(async () => {
            fireEvent.click(saveButton());
        });
        expect(document.body.textContent).toContain('app.profileSaveError');
    });

    test('Delete requires a second confirming click', async () => {
        mockApi.getChallengeProfiles.mockResolvedValue({ tactic: { exposure: 80 } });
        renderBar();
        await waitFor(() => {
            expect(document.body.textContent).toContain('tactic (1)');
        });
        await act(async () => {
            changeSelect(selectEl(), 'tactic');
        });

        await act(async () => {
            fireEvent.click(deleteButton());
        });
        // Armed, not deleted.
        expect(mockApi.deleteChallengeProfile).not.toHaveBeenCalled();
        expect(document.body.textContent).toContain('app.confirmDelete');

        await act(async () => {
            fireEvent.click(deleteButton());
        });
        expect(mockApi.deleteChallengeProfile).toHaveBeenCalledWith('tactic');
    });

    test('failed Delete keeps the selection and does not notify the parent', async () => {
        mockApi.getChallengeProfiles.mockResolvedValue({ tactic: { exposure: 80 } });
        mockApi.deleteChallengeProfile.mockResolvedValue(false);
        const onProfilesChanged = jest.fn();
        renderBar({ onProfilesChanged });
        await waitFor(() => expect(document.body.textContent).toContain('tactic (1)'));
        await act(async () => changeSelect(selectEl(), 'tactic'));

        await act(async () => fireEvent.click(deleteButton()));
        await act(async () => fireEvent.click(deleteButton()));

        expect(selectEl().value).toBe('tactic');
        expect(document.body.textContent).toContain('app.profileSaveError');
        expect(onProfilesChanged).not.toHaveBeenCalled();
    });

    test('notifies the parent after a saved profile mutation', async () => {
        const onProfilesChanged = jest.fn();
        renderBar({ onProfilesChanged });
        fireEvent.change(nameInput(), { target: { value: 'new tactic' } });

        await act(async () => {
            fireEvent.click(saveButton());
        });

        await waitFor(() => expect(onProfilesChanged).toHaveBeenCalledTimes(1));
    });

    test('changing the selection disarms a pending delete confirm', async () => {
        mockApi.getChallengeProfiles.mockResolvedValue({ a: {}, b: {} });
        renderBar();
        await waitFor(() => {
            expect(document.body.textContent).toContain('a (0)');
        });
        await act(async () => {
            changeSelect(selectEl(), 'a');
        });
        await act(async () => {
            fireEvent.click(deleteButton());
        });
        expect(document.body.textContent).toContain('app.confirmDelete');

        await act(async () => {
            changeSelect(selectEl(), 'b');
        });
        // Back to the idle label — the next click arms again, never fires.
        expect(document.body.textContent).not.toContain('app.confirmDelete');
        expect(mockApi.deleteChallengeProfile).not.toHaveBeenCalled();
    });

    test('an armed confirm falls back to idle after the timeout', async () => {
        jest.useFakeTimers();
        try {
            mockApi.getChallengeProfiles.mockResolvedValue({ tactic: {} });
            renderBar();
            await act(async () => {});
            await act(async () => changeSelect(selectEl(), 'tactic'));
            await act(async () => fireEvent.click(deleteButton()));
            expect(deleteButton().textContent).toBe('app.confirmDelete');
            await act(async () => jest.advanceTimersByTime(4000));
            expect(deleteButton().textContent).toBe('app.deleteProfile');
            expect(mockApi.deleteChallengeProfile).not.toHaveBeenCalled();
        } finally {
            jest.useRealTimers();
        }
    });

    test('a non-object profiles reply reads as no profiles', async () => {
        mockApi.getChallengeProfiles.mockResolvedValue(null);
        renderBar();
        await waitFor(() => expect(mockApi.getChallengeProfiles).toHaveBeenCalled());
        expect(screen.getByRole('option').textContent).toBe('app.noProfiles');
    });

    test.each([
        ['an Error', new Error('disk'), 'Error loading challenge profiles: disk'],
        ['a bare value', 'nope', 'Error loading challenge profiles: nope'],
    ])('a failed profiles load (%s) is logged and shows none', async (_label, rejection, logged) => {
        mockApi.getChallengeProfiles.mockRejectedValue(rejection);
        renderBar();
        await waitFor(() => expect(mockApi.logError).toHaveBeenCalledWith(logged));
        expect(screen.getByRole('option').textContent).toBe('app.noProfiles');
    });

    test.each([
        ['an Error', new Error('io'), 'Error deleting challenge profile: io'],
        ['a bare value', 'io', 'Error deleting challenge profile: io'],
    ])('a thrown Delete (%s) is logged and re-enables the buttons', async (_label, rejection, logged) => {
        mockApi.getChallengeProfiles.mockResolvedValue({ tactic: {} });
        mockApi.deleteChallengeProfile.mockRejectedValue(rejection);
        renderBar();
        await waitFor(() => expect(document.body.textContent).toContain('tactic (0)'));
        await act(async () => changeSelect(selectEl(), 'tactic'));
        await act(async () => fireEvent.click(deleteButton()));
        await act(async () => fireEvent.click(deleteButton()));
        await waitFor(() => expect(deleteButton().disabled).toBe(false));
        expect(mockApi.logError).toHaveBeenCalledWith(logged);
    });

    test('a successful Delete clears the selection, refreshes and notifies', async () => {
        mockApi.getChallengeProfiles.mockResolvedValueOnce({ tactic: {} }).mockResolvedValueOnce({});
        const onProfilesChanged = jest.fn();
        renderBar({ onProfilesChanged });
        await waitFor(() => expect(document.body.textContent).toContain('tactic (0)'));
        await act(async () => changeSelect(selectEl(), 'tactic'));
        await act(async () => fireEvent.click(deleteButton()));
        await act(async () => fireEvent.click(deleteButton()));
        await waitFor(() => expect(onProfilesChanged).toHaveBeenCalledWith({ name: 'tactic', deleted: true }));
        expect(selectEl().value).toBe('');
        expect(screen.getByRole('option').textContent).toBe('app.noProfiles');
    });

    test.each([
        ['an Error', new Error('full'), 'Error saving challenge profile: full'],
        ['a bare value', 'full', 'Error saving challenge profile: full'],
    ])('a thrown Save (%s) is logged and shows the generic error', async (_label, rejection, logged) => {
        mockApi.saveChallengeProfile.mockRejectedValue(rejection);
        renderBar();
        fireEvent.change(nameInput(), { target: { value: 'p' } });
        await act(async () => fireEvent.click(saveButton()));
        await waitFor(() => expect(document.body.textContent).toContain('app.profileSaveError'));
        expect(mockApi.logError).toHaveBeenCalledWith(logged);
    });

    test('without limits the client-side caps are skipped', async () => {
        const many = {};
        for (let i = 0; i < 60; i++) many[`p${i}`] = {};
        mockApi.getChallengeProfiles.mockResolvedValue(many);
        render(<ChallengeProfilesBar overrides={{ a: 1 }} onApply={jest.fn()} />);
        await waitFor(() => expect(document.body.textContent).toContain('p0 (0)'));
        fireEvent.change(nameInput(), { target: { value: 'y'.repeat(200) } });
        await act(async () => fireEvent.click(saveButton()));
        expect(mockApi.saveChallengeProfile).toHaveBeenCalledWith('y'.repeat(200), { a: 1 });
    });

    test('typing a new name disarms a pending overwrite', async () => {
        mockApi.getChallengeProfiles.mockResolvedValue({ Tactic: {} });
        renderBar();
        await waitFor(() => expect(document.body.textContent).toContain('Tactic (0)'));
        fireEvent.change(nameInput(), { target: { value: 'tactic' } });
        await act(async () => fireEvent.click(saveButton()));
        expect(saveButton().textContent).toBe('app.confirmOverwrite');
        fireEvent.change(nameInput(), { target: { value: 'tactic2' } });
        expect(saveButton().textContent).toBe('app.saveAsProfile');
        // A plain edit while nothing is armed keeps the idle label.
        fireEvent.change(nameInput(), { target: { value: 'tactic3' } });
        expect(saveButton().textContent).toBe('app.saveAsProfile');
    });

    test('a saved name the refreshed list does not carry leaves Apply disabled', async () => {
        mockApi.getChallengeProfiles.mockResolvedValueOnce({}).mockResolvedValueOnce({ Other: {} });
        renderBar();
        fireEvent.change(nameInput(), { target: { value: 'mine' } });
        await act(async () => fireEvent.click(saveButton()));
        await waitFor(() => expect(document.body.textContent).toContain('Other (0)'));
        expect(applyButton().disabled).toBe(true);
    });

    describe('built-in intent presets', () => {
        const JUST = {
            exposure: 100,
            exposureTarget: 0,
            autoBoost: false,
            useTurbo: false,
            autoTurbo: false,
            autoFill: true,
        };

        test('are starred, translated and marked built-in while unedited', async () => {
            mockApi.getChallengeProfiles.mockResolvedValue({ 'Just Participate': JUST, mine: {} });
            renderBar();
            await waitFor(() => expect(document.body.textContent).toContain('★ app.intentJustParticipate (6)'));
            await act(async () => changeSelect(selectEl(), 'Just Participate'));
            const badge = screen.getByText('app.intentBuiltIn');
            expect(badge.className).toContain('badge-info');
            expect(document.body.textContent).toContain('app.intentJustParticipateDesc');
        });

        test('are marked modified once their values differ', async () => {
            mockApi.getChallengeProfiles.mockResolvedValue({ 'Just Participate': { ...JUST, autoFill: false } });
            renderBar();
            await waitFor(() => expect(document.body.textContent).toContain('★'));
            await act(async () => changeSelect(selectEl(), 'Just Participate'));
            expect(screen.getByText('app.intentModified').className).toContain('badge-warning');
        });
    });
});
