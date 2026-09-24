/**
 * ChallengeSettingsModal: load/save error paths, profile interplay, and the
 * voting-pause / pre-boost-fill / time-formatting hints. Driven through
 * window.api mocks with a controllable settings schema.
 * `t(key)` returns the key unless a template is registered in TEMPLATES.
 */
import { act, fireEvent, render, screen, waitFor } from './helpers/test-utils';
import { ChallengeSettingsModal } from '@/components/app/ChallengeSettingsModal';
import { mockApi, mockTranslator } from './helpers/setup';

const field = (group, type, dflt) => ({
    type,
    default: dflt,
    perChallenge: true,
    group,
    label: 'app.label',
    description: 'app.desc',
});

const BASE_SCHEMA = {
    boostTime: field('boost', 'number', 30),
    keyUnlockedBoostTime: field('boost', 'number', 0),
    voteBeforeBoost: field('boost', 'boolean', false),
    onlyBoost: field('boost', 'boolean', false),
    autoBoost: field('boost', 'boolean', true),
    voteOnlyInLastMinute: field('boost', 'boolean', false),
    useVotingPause: field('pause', 'boolean', false),
    votingPauseTime: field('pause', 'timeOfDayList', []),
    votingPauseBeforeEnd: field('pause', 'timeList', []),
    votingPauseDurationMinutes: field('pause', 'number', 240),
    useScheduledFill: field('sf', 'boolean', false),
    scheduledFillTime: field('sf', 'timeOfDayList', []),
    scheduledFillBeforeEnd: field('sf', 'timeList', []),
    scheduledFillWindowMinutes: field('sf', 'number', 60),
    scheduledFillReplaces: field('sf', 'boolean', false),
    globalOnly: { type: 'number', default: 1, group: 'boost', label: 'app.globalOnly', description: 'x' },
};

// Every default mirrored EXCEPT keyUnlockedBoostTime, so that row falls back to
// the schema's own default.
const BASE_DEFAULTS = Object.fromEntries(
    Object.entries(BASE_SCHEMA)
        .filter(([key]) => key !== 'keyUnlockedBoostTime')
        .map(([key, cfg]) => [key, cfg.default]),
);

const mockSchemaState = {};
const resetSchema = () =>
    Object.assign(mockSchemaState, {
        schema: { ...BASE_SCHEMA },
        defaults: { ...BASE_DEFAULTS },
        groups: [
            { id: 'boost', label: 'app.groupBoost' },
            { id: 'pause', label: 'app.groupPause' },
            { id: 'sf', label: 'app.groupSf' },
        ],
        tiers: [],
        profileLimits: null,
        refetch: jest.fn(),
        loading: false,
    });

jest.mock('@/api/useSettingsSchema', () => ({
    useSettingsSchema: () => mockSchemaState,
}));

const TEMPLATES = {
    'app.votingPauseActiveHint': 'PAUSE-UNTIL {0} {1}',
    'app.votingPauseNextHint': 'PAUSE-NEXT {0}-{1} {2} {3}',
    'app.scheduledFillNextHint': 'FILL-NEXT {0}-{1} {2} {3}',
    'app.scheduledFillSourceBeforeEnd': 'BEFORE {0}',
    'app.votingPauseShortWindowHint': 'PAUSE-SHORT {0}',
};

const NOW_SEC = () => Math.floor(Date.now() / 1000);
const HHMM = /\d\d:\d\d/.source;

beforeEach(() => {
    window.api = mockApi;
    resetSchema();
    mockTranslator.t.mockImplementation((key) => TEMPLATES[key] ?? key);
    mockApi.getTitleProfile.mockReset().mockResolvedValue(null);
    mockApi.getChallengeOverrides.mockReset().mockResolvedValue({});
    mockApi.getSettings.mockReset().mockResolvedValue({ timezone: 'UTC', checkFrequencyMax: 30 });
    mockApi.getChallengeProfiles.mockReset().mockResolvedValue({});
    mockApi.replaceChallengeOverrides.mockReset().mockResolvedValue(true);
    mockApi.saveChallengeProfile.mockReset().mockResolvedValue(true);
    mockApi.deleteChallengeProfile.mockReset().mockResolvedValue(true);
    mockApi.logError.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
    mockTranslator.t.mockImplementation((key) => key);
});

const renderModal = (props = {}) => {
    const onClose = jest.fn();
    const utils = render(
        <ChallengeSettingsModal
            isOpen={true}
            onClose={onClose}
            challengeId="1"
            challengeTitle="Challenge 1"
            challenge={{ type: 'default', close_time: NOW_SEC() + 7200, member: {} }}
            {...props}
        />,
    );
    return { ...utils, onClose };
};

const loaded = () => waitFor(() => expect(screen.getByRole('button', { name: 'app.save' })).toBeTruthy());
const body = () => document.body.textContent;

describe('loading', () => {
    test('stays on the spinner without a challenge id', async () => {
        renderModal({ challengeId: null });
        await act(async () => {});
        expect(screen.queryByRole('button', { name: 'app.save' })).toBeNull();
        expect(mockApi.getChallengeOverrides).not.toHaveBeenCalled();
    });

    test('a schema refetch mid-session does not reload over in-progress edits', async () => {
        const { rerender, onClose } = renderModal();
        await loaded();
        const input = document.querySelector('input[type="number"]');
        fireEvent.input(input, { target: { value: '12' } });
        fireEvent.blur(input);
        await waitFor(() => expect(screen.getAllByText('app.overridden').length).toBeGreaterThan(0));
        mockSchemaState.schema = { ...BASE_SCHEMA };
        rerender(
            <ChallengeSettingsModal isOpen={true} onClose={onClose} challengeId="1" challengeTitle="Challenge 1" />,
        );
        await act(async () => {});
        expect(mockApi.getChallengeOverrides).toHaveBeenCalledTimes(1);
        expect(document.querySelector('input[type="number"]').value).toBe('12');
    });

    test('a null stored-override map loads as no overrides', async () => {
        mockApi.getChallengeOverrides.mockResolvedValue(null);
        renderModal();
        await loaded();
        expect(body()).toContain('app.overridesNoneSummary');
        expect(body()).not.toContain('app.overridden');
    });

    test('only perChallenge keys are loaded from the stored map', async () => {
        mockApi.getChallengeOverrides.mockResolvedValue({ boostTime: 5, globalOnly: 9 });
        renderModal();
        await loaded();
        expect(screen.getAllByText('app.overridden')).toHaveLength(1);
    });

    test.each([
        ['an Error', new Error('ipc'), 'Error loading challenge overrides: ipc'],
        ['a bare value', 'ipc', 'Error loading challenge overrides: ipc'],
    ])('a failed load (%s) is logged and replaces the form with an alert', async (_label, rejection, logged) => {
        mockApi.getChallengeOverrides.mockRejectedValue(rejection);
        renderModal();
        await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('app.challengeOverridesLoadError'));
        expect(mockApi.logError).toHaveBeenCalledWith(logged);
        // No Save: the form would hold empty overrides and wipe the stored ones.
        expect(screen.queryByRole('button', { name: 'app.save' })).toBeNull();
    });

    test('a load that fails after the modal closed is dropped silently', async () => {
        let reject;
        mockApi.getChallengeOverrides.mockImplementation(() => new Promise((_, r) => (reject = r)));
        const { rerender, onClose } = renderModal();
        await waitFor(() => expect(mockApi.getChallengeOverrides).toHaveBeenCalled());
        rerender(<ChallengeSettingsModal isOpen={false} onClose={onClose} challengeId="1" challengeTitle="x" />);
        await act(async () => reject(new Error('late')));
        expect(mockApi.logError).not.toHaveBeenCalled();
    });

    test('app settings fall back to defaults when unreadable', async () => {
        mockApi.getSettings.mockResolvedValue(null);
        const { unmount } = renderModal();
        await loaded();
        unmount();
        mockApi.getSettings.mockRejectedValue(new Error('no settings'));
        renderModal();
        await loaded();
        expect(body()).toContain('app.save');
    });

    test('app settings that resolve or fail after close are ignored', async () => {
        let resolve;
        mockApi.getSettings.mockImplementation(() => new Promise((r) => (resolve = r)));
        const { rerender, onClose } = renderModal();
        rerender(<ChallengeSettingsModal isOpen={false} onClose={onClose} challengeId="1" challengeTitle="x" />);
        await act(async () => resolve({ timezone: 'UTC' }));

        let reject;
        mockApi.getSettings.mockImplementation(() => new Promise((_, r) => (reject = r)));
        rerender(<ChallengeSettingsModal isOpen={true} onClose={onClose} challengeId="1" challengeTitle="x" />);
        rerender(<ChallengeSettingsModal isOpen={false} onClose={onClose} challengeId="1" challengeTitle="x" />);
        await act(async () => reject(new Error('late')));
        expect(document.querySelector('[role="dialog"]')).toBeNull();
    });
});

describe('editing and saving', () => {
    test('editing a field marks it overridden; its reset clears it again', async () => {
        renderModal();
        await loaded();
        const input = document.querySelector('input[type="number"]');
        fireEvent.input(input, { target: { value: '12' } });
        fireEvent.blur(input);
        await waitFor(() => expect(screen.getAllByText('app.overridden').length).toBeGreaterThan(0));
        fireEvent.click(document.querySelector('button[title="app.resetToDefaultNotSaved"]'));
        await waitFor(() => expect(screen.queryByText('app.overridden')).toBeNull());
    });

    test('a rejected save keeps the modal open with an alert', async () => {
        mockApi.replaceChallengeOverrides.mockResolvedValue(false);
        const { onClose } = renderModal();
        await loaded();
        fireEvent.click(screen.getByRole('button', { name: 'app.save' }));
        await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('app.settingsSaveError'));
        expect(onClose).not.toHaveBeenCalled();
    });

    test('a successful save closes and passes the non-suppressed mode', async () => {
        const { onClose } = renderModal();
        await loaded();
        fireEvent.click(screen.getByRole('button', { name: 'app.save' }));
        await waitFor(() => expect(onClose).toHaveBeenCalled());
        expect(mockApi.replaceChallengeOverrides).toHaveBeenCalledWith('1', {}, false);
    });

    test.each([
        ['an Error', new Error('disk'), 'Error saving challenge settings: disk'],
        ['a bare value', 'disk', 'Error saving challenge settings: disk'],
    ])('a thrown save (%s) is logged and the modal stays open', async (_label, rejection, logged) => {
        mockApi.replaceChallengeOverrides.mockRejectedValue(rejection);
        const { onClose } = renderModal();
        await loaded();
        fireEvent.click(screen.getByRole('button', { name: 'app.save' }));
        await waitFor(() => expect(mockApi.logError).toHaveBeenCalledWith(logged));
        expect(onClose).not.toHaveBeenCalled();
    });

    test('Save is a no-op once the schema or the challenge id is gone', async () => {
        const { rerender, onClose } = renderModal();
        await loaded();
        mockSchemaState.schema = null;
        rerender(
            <ChallengeSettingsModal isOpen={true} onClose={onClose} challengeId="1" challengeTitle="Challenge 1" />,
        );
        fireEvent.click(screen.getByRole('button', { name: 'app.save' }));
        mockSchemaState.schema = { ...BASE_SCHEMA };
        rerender(
            <ChallengeSettingsModal isOpen={true} onClose={onClose} challengeId={null} challengeTitle="Challenge 1" />,
        );
        fireEvent.click(screen.getByRole('button', { name: 'app.save' }));
        await act(async () => {});
        expect(mockApi.replaceChallengeOverrides).not.toHaveBeenCalled();
        expect(onClose).not.toHaveBeenCalled();
    });

    test('Clear All re-enables an automatic title profile', async () => {
        mockApi.getTitleProfile.mockResolvedValue({ name: 'Auto', values: { boostTime: 17 }, suppressed: true });
        mockApi.getChallengeOverrides.mockResolvedValue({ boostTime: 5 });
        renderModal();
        await loaded();
        expect(body()).not.toContain('app.usingProfile: Auto');
        fireEvent.click(screen.getByRole('button', { name: 'app.clearAll' }));
        await waitFor(() => expect(body()).toContain('app.usingProfile: Auto'));
        fireEvent.click(screen.getByRole('button', { name: 'app.save' }));
        await waitFor(() => expect(mockApi.replaceChallengeOverrides).toHaveBeenCalledWith('1', {}, false));
    });
});

describe('profiles bar interplay', () => {
    const select = async (name) => {
        const el = screen.getByRole('combobox');
        await act(async () => {
            el.value = name;
            el.dispatchEvent(new window.Event('change', { bubbles: true }));
        });
    };

    test('saving the assigned title profile refreshes the inherited values', async () => {
        mockApi.getTitleProfile.mockResolvedValue({ name: 'Auto', values: { boostTime: 17 } });
        mockApi.getChallengeOverrides.mockResolvedValue({ boostTime: 8 });
        renderModal();
        await loaded();
        fireEvent.input(screen.getByPlaceholderText('app.profileNamePlaceholder'), { target: { value: 'AUTO' } });
        await act(async () => fireEvent.click(screen.getByRole('button', { name: 'app.saveAsProfile' })));
        await waitFor(() => expect(mockApi.saveChallengeProfile).toHaveBeenCalledWith('AUTO', { boostTime: 8 }));
        // The override is cleared → the row now inherits the re-saved profile value.
        fireEvent.click(document.querySelector('button[title="app.resetToDefaultNotSaved"]'));
        await waitFor(() => expect(document.querySelector('input[type="number"]').value).toBe('8'));
        expect(body()).toContain('app.usingProfile: AUTO');
    });

    test('saving a differently named profile leaves the title profile alone (also with none assigned)', async () => {
        renderModal();
        await loaded();
        fireEvent.input(screen.getByPlaceholderText('app.profileNamePlaceholder'), { target: { value: 'Other' } });
        await act(async () => fireEvent.click(screen.getByRole('button', { name: 'app.saveAsProfile' })));
        await waitFor(() => expect(mockApi.saveChallengeProfile).toHaveBeenCalled());
        expect(body()).not.toContain('app.usingProfile:');
    });

    test('deleting the assigned profile after a manual Apply keeps it suppressed', async () => {
        mockApi.getTitleProfile.mockResolvedValue({ name: 'Auto', values: { boostTime: 17 } });
        mockApi.getChallengeProfiles.mockResolvedValue({ Auto: { boostTime: 17 }, Manual: { boostTime: 3 } });
        renderModal();
        await loaded();
        await waitFor(() => expect(body()).toContain('Manual (1)'));
        await select('Manual');
        fireEvent.click(screen.getByRole('button', { name: 'app.applyProfile' }));
        await select('Auto');
        await act(async () => fireEvent.click(screen.getByRole('button', { name: 'app.deleteProfile' })));
        await act(async () => fireEvent.click(screen.getByRole('button', { name: 'app.confirmDelete' })));
        await waitFor(() => expect(mockApi.deleteChallengeProfile).toHaveBeenCalledWith('Auto'));
        fireEvent.click(screen.getByRole('button', { name: 'app.save' }));
        await waitFor(() =>
            expect(mockApi.replaceChallengeOverrides).toHaveBeenCalledWith('1', { boostTime: 3 }, true),
        );
    });

    test('applying a replace-mode profile over an existing replace override shows no new warning', async () => {
        mockApi.getChallengeOverrides.mockResolvedValue({ scheduledFillReplaces: true });
        mockApi.getChallengeProfiles.mockResolvedValue({
            R: { scheduledFillReplaces: true, globalOnly: 5, notInSchema: 1 },
        });
        renderModal();
        await loaded();
        await waitFor(() => expect(body()).toContain('R (3)'));
        await select('R');
        fireEvent.click(screen.getByRole('button', { name: 'app.applyProfile' }));
        await waitFor(() => expect(body()).toContain('app.profileAppliedHint'));
        expect(body()).not.toContain('app.scheduledFillProfileReplacesWarning');
        // Keys that aren't per-challenge settings are dropped from the applied profile.
        fireEvent.click(screen.getByRole('button', { name: 'app.save' }));
        await waitFor(() =>
            expect(mockApi.replaceChallengeOverrides).toHaveBeenCalledWith('1', { scheduledFillReplaces: true }, true),
        );
    });
});

describe('voting pause hints', () => {
    test('enabled with no times → no-times warning', async () => {
        mockApi.getChallengeOverrides.mockResolvedValue({ useVotingPause: true });
        renderModal();
        await loaded();
        expect(body()).toContain('app.votingPauseNoTimesHint');
    });

    test('a pause already open reports when voting resumes', async () => {
        mockApi.getChallengeOverrides.mockResolvedValue({ useVotingPause: true, votingPauseBeforeEnd: [3600] });
        renderModal({ challenge: { type: 'default', close_time: NOW_SEC() + 1800, member: {} } });
        await loaded();
        expect(body()).toMatch(new RegExp(`PAUSE-UNTIL ${HHMM} UTC`));
    });

    test('an upcoming before-end pause names its window and source', async () => {
        mockApi.getChallengeOverrides.mockResolvedValue({ useVotingPause: true, votingPauseBeforeEnd: [600] });
        renderModal();
        await loaded();
        expect(body()).toMatch(new RegExp(`PAUSE-NEXT ${HHMM}-${HHMM} UTC BEFORE`));
    });

    test('a pause whose only window is past shows no next hint', async () => {
        mockApi.getChallengeOverrides.mockResolvedValue({
            useVotingPause: true,
            votingPauseBeforeEnd: [5 * 3600],
            votingPauseDurationMinutes: 60,
        });
        renderModal();
        await loaded();
        expect(body()).not.toContain('PAUSE-NEXT');
        expect(body()).not.toContain('PAUSE-UNTIL');
        expect(body()).not.toContain('app.votingPauseNoTimesHint');
    });

    test('daily pauses that cover the whole day warn, naming the daily time as source', async () => {
        mockApi.getChallengeOverrides.mockResolvedValue({
            useVotingPause: true,
            votingPauseTime: ['00:00', '12:00'],
            votingPauseDurationMinutes: 720,
        });
        renderModal();
        await loaded();
        expect(body()).toContain('app.votingPauseAllDayHint');
        expect(body()).toMatch(/PAUSE-(UNTIL|NEXT)/);
    });

    test('a daily time-of-day source is shown verbatim', async () => {
        const later = new Date((NOW_SEC() + 3 * 3600) * 1000);
        const hhmm = `${String(later.getUTCHours()).padStart(2, '0')}:${String(later.getUTCMinutes()).padStart(2, '0')}`;
        mockApi.getChallengeOverrides.mockResolvedValue({
            useVotingPause: true,
            votingPauseTime: [hhmm],
            votingPauseDurationMinutes: 30,
        });
        renderModal();
        await loaded();
        expect(body()).toContain(`UTC ${hhmm}`);
    });

    test('a pause shorter than the longest check gap warns on the duration row', async () => {
        mockApi.getChallengeOverrides.mockResolvedValue({
            useVotingPause: true,
            votingPauseBeforeEnd: [600],
            votingPauseDurationMinutes: 10,
        });
        renderModal();
        await loaded();
        expect(body()).toContain('PAUSE-SHORT 30');
    });

    test.each([
        ['the pause is off', { votingPauseDurationMinutes: 10 }, { timezone: 'UTC', checkFrequencyMax: 30 }],
        [
            'the check gap is unknown',
            { useVotingPause: true, votingPauseBeforeEnd: [600], votingPauseDurationMinutes: 10 },
            { timezone: 'UTC' },
        ],
        [
            'the pause outlasts the gap',
            { useVotingPause: true, votingPauseBeforeEnd: [600], votingPauseDurationMinutes: 45 },
            { timezone: 'UTC', checkFrequencyMax: 30 },
        ],
    ])('no short-pause warning when %s', async (_label, overrides, settings) => {
        mockApi.getSettings.mockResolvedValue(settings);
        mockApi.getChallengeOverrides.mockResolvedValue(overrides);
        renderModal();
        await loaded();
        expect(body()).not.toContain('PAUSE-SHORT');
    });
});

describe('pre-boost fill hints', () => {
    test('warns about every setting that cancels the fill', async () => {
        mockApi.getChallengeOverrides.mockResolvedValue({
            voteBeforeBoost: true,
            onlyBoost: true,
            autoBoost: false,
            voteOnlyInLastMinute: true,
            boostTime: 0,
        });
        renderModal();
        await loaded();
        for (const key of [
            'app.voteBeforeBoostOnlyBoostHint',
            'app.voteBeforeBoostNoAutoBoostHint',
            'app.voteBeforeBoostLastMinuteOnlyHint',
            'app.voteBeforeBoostNoBoostTimeHint',
        ]) {
            expect(body()).toContain(key);
        }
    });

    test('a compatible configuration shows none of them', async () => {
        mockApi.getChallengeOverrides.mockResolvedValue({
            voteBeforeBoost: true,
            boostTime: 0,
            keyUnlockedBoostTime: 5,
        });
        renderModal();
        await loaded();
        expect(body()).not.toMatch(/app\.voteBeforeBoost\w+Hint/);
    });

    test('nothing while the pre-boost fill is off', async () => {
        mockApi.getChallengeOverrides.mockResolvedValue({ onlyBoost: true, autoBoost: false });
        renderModal();
        await loaded();
        expect(body()).not.toMatch(/app\.voteBeforeBoost\w+Hint/);
    });
});

describe('window time formatting', () => {
    test('an unknown app timezone falls back to a UTC HH:MM label', async () => {
        mockApi.getSettings.mockResolvedValue({ timezone: 'Not/AZone', checkFrequencyMax: 0 });
        mockApi.getChallengeOverrides.mockResolvedValue({ useScheduledFill: true, scheduledFillBeforeEnd: [600] });
        renderModal();
        await loaded();
        expect(body()).toMatch(new RegExp(`FILL-NEXT ${HHMM}-${HHMM} Not/AZone BEFORE`));
    });

    test('an out-of-range window start renders a dash instead of crashing', async () => {
        mockApi.getChallengeOverrides.mockResolvedValue({
            useScheduledFill: true,
            scheduledFillBeforeEnd: [1e300],
            scheduledFillWindowMinutes: 1e300,
        });
        renderModal();
        await loaded();
        expect(body()).toContain('FILL-NEXT —-—');
    });
});
