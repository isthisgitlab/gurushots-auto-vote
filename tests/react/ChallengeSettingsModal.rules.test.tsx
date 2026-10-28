/**
 * The per-challenge settings modal and the values a challenge's rules set directly (a scenario,
 * auto-join, a chosen photos list): they show as the inherited value with the rule that set them
 * ("From rule: {title}"), not as the plain default ("None"), whether or not the rule's profile
 * applies. Saving stores only what the user changed.
 */
import { act, fireEvent, render, screen, waitFor, within } from './helpers/test-utils';
import { ChallengeSettingsModal } from '@/components/app/ChallengeSettingsModal';
import { mockApi, mockTranslator, fillTemplate } from './helpers/setup';
import { titleRuleInfo } from './helpers/titleRules';
import type { useSettingsSchema } from '@/api/useSettingsSchema';
import { invalid } from '../helpers/invalid';
import { app as lvApp } from '../../src/ts/translations/latvian';

const field = (type: string, dflt: unknown, label: string) => ({
    type,
    default: dflt,
    perChallenge: true,
    group: 'autoSubmit',
    label,
    description: 'app.desc',
});

const mockSchemaState: Partial<ReturnType<typeof useSettingsSchema>> = {
    schema: invalid({
        scenario: field('scenario', '', 'app.scenario'),
        autoJoin: field('boolean', false, 'app.autoJoin'),
        chosenPhotos: field('photos', [], 'app.chosenPhotos'),
        boostTime: field('number', 30, 'app.boostTime'),
    }),
    defaults: { scenario: '', autoJoin: false, chosenPhotos: [], boostTime: 30 },
    groups: [{ id: 'autoSubmit', label: 'app.groupAutoSubmit', tier: 'core' }],
    tiers: [{ id: 'core', label: 'app.tierCore' }],
    profileLimits: null,
    refetch: jest.fn(),
    loading: false,
};

jest.mock('@/api/useSettingsSchema', () => ({
    useSettingsSchema: () => mockSchemaState,
}));

const PHOTO = `00000001${'a'.repeat(24)}`;

beforeEach(() => {
    window.api = invalid(mockApi);
    mockTranslator.t.mockImplementation((key, vars) =>
        fillTemplate(key === 'app.fromRule' ? 'From rule: {title}' : key, vars),
    );
    mockApi.getTitleProfile.mockReset().mockResolvedValue(titleRuleInfo());
    mockApi.getChallengeOverrides.mockReset().mockResolvedValue({});
    mockApi.getChallengeProfiles.mockReset().mockResolvedValue({});
    mockApi.getScenarios
        .mockReset()
        .mockResolvedValue({ success: true, scenarios: invalid({ Plan: {} }), templates: [] });
    mockApi.replaceChallengeOverrides.mockReset().mockResolvedValue(true);
    mockApi.logError.mockReset().mockResolvedValue(invalid(undefined));
});

afterEach(() => {
    mockTranslator.t.mockImplementation((key) => key);
});

const open = async () => {
    const onClose = jest.fn();
    render(<ChallengeSettingsModal isOpen onClose={onClose} challengeId="1" challengeTitle="Seaside" />);
    await screen.findByRole('button', { name: 'app.save' });
    // The scenario names arrive after the form: wait for the option so the select can show its value.
    await screen.findByRole('option', { name: 'Plan' });
    return { onClose };
};

/** The cell of a setting, found by its label. */
const cell = (label: string) => screen.getByText(label).closest<HTMLElement>('.rounded-box')!;
/** The source badge of a setting's cell, found by its wording (the cell also holds the "?" help badge). */
const badge = (label: string, text: string) => within(cell(label)).getByText(text).closest<HTMLElement>('.badge')!;
const scenarioSelect = () => document.getElementById('challenge-setting-scenario') as HTMLSelectElement;
const withRule = () =>
    titleRuleInfo({
        inlineValues: { scenario: 'Plan', autoJoin: true, chosenPhotos: [PHOTO] },
        ruleSources: {
            scenario: { title: 'Seaside', index: 1 },
            autoJoin: { title: 'Seaside', index: 1 },
            chosenPhotos: { title: 'Seaside', index: 1 },
        },
    });

test('a scenario, auto-join and chosen photos a rule sets show as inherited, with the rule, not as "None"', async () => {
    mockApi.getTitleProfile.mockResolvedValue(withRule());
    await open();
    expect(scenarioSelect().value).toBe('Plan');
    expect(cell('app.scenario').textContent).toContain('From rule: Seaside');
    expect(cell('app.scenario').textContent).toContain('📏 From rule: Seaside');
    expect(cell('app.autoJoin').textContent).toContain('From rule: Seaside');
    expect(document.querySelector<HTMLInputElement>('#challenge-setting-autoJoin')!.checked).toBe(true);
    expect(cell('app.chosenPhotos').textContent).toContain('From rule: Seaside');
    // A key no rule sets is still the global default.
    expect(cell('app.boostTime').textContent).toContain('app.usingGlobal');
    expect(cell('app.boostTime').textContent).not.toContain('From rule');
    // The source badges are coloured: a rule's value secondary, the global default ghost.
    expect(badge('app.scenario', 'From rule: Seaside').className).toContain('badge-secondary');
    expect(badge('app.boostTime', 'app.usingGlobal').className).toContain('badge-ghost');
    // The lookup carries the challenge id, so rules keyed on tags or type resolve too.
    expect(mockApi.getTitleProfile).toHaveBeenCalledWith('Seaside', '1');
});

test('with several matching rules each key names the rule that set it', async () => {
    mockApi.getTitleProfile.mockResolvedValue(
        titleRuleInfo({
            inlineValues: { scenario: 'Plan', autoJoin: true },
            ruleSources: { scenario: { title: 'First rule', index: 1 }, autoJoin: { title: 'Comm', index: 1 } },
        }),
    );
    await open();
    expect(cell('app.scenario').textContent).toContain('From rule: First rule');
    expect(cell('app.autoJoin').textContent).toContain('From rule: Comm');
});

test('a profile value is "Using profile", an inline value of the same rule is "From rule", and the summary names the profile', async () => {
    mockApi.getTitleProfile.mockResolvedValue(
        titleRuleInfo({
            profile: { name: 'Quad', values: { boostTime: 17 } },
            inlineValues: { scenario: 'Plan' },
            ruleSources: { scenario: { title: 'Seaside', index: 1 } },
        }),
    );
    await open();
    expect(cell('app.boostTime').textContent).toContain('app.usingProfile');
    expect(cell('app.boostTime').textContent).not.toContain('From rule');
    expect(badge('app.boostTime', 'app.usingProfile').className).toContain('badge-info');
    expect(cell('app.scenario').textContent).toContain('From rule: Seaside');
    expect(badge('app.scenario', 'From rule: Seaside').className).toContain('badge-secondary');
    expect(document.body.textContent).toContain('app.usingProfile: Quad');
});

test('"Using profile" is not claimed when no rule names a profile, however many values rules set', async () => {
    mockApi.getTitleProfile.mockResolvedValue(withRule());
    await open();
    expect(document.body.textContent).not.toContain('app.usingProfile');
});

test("with the profile suppressed the rule's own values stay and the profile's go", async () => {
    mockApi.getTitleProfile.mockResolvedValue(
        titleRuleInfo({
            profile: { name: 'Quad', values: { boostTime: 17 } },
            suppressed: true,
            inlineValues: { scenario: 'Plan' },
            ruleSources: { scenario: { title: 'Seaside', index: 1 } },
        }),
    );
    await open();
    expect(scenarioSelect().value).toBe('Plan');
    expect(cell('app.scenario').textContent).toContain('From rule: Seaside');
    expect(cell('app.boostTime').textContent).toContain('app.usingGlobal');
    expect(document.body.textContent).not.toContain('app.usingProfile');
});

test("a key the matched profile supplies is the profile's, not credited to a later rule that sets it inline; suppressed, that rule is", async () => {
    mockApi.getTitleProfile.mockResolvedValue(
        titleRuleInfo({
            profile: { name: 'Quad', values: { autoJoin: false } },
            inlineValues: { autoJoin: true, scenario: 'Plan' },
            ruleValues: { autoJoin: false, scenario: 'Plan' },
            ruleSources: {
                autoJoin: { title: 'Seaside', index: 1, viaProfile: true },
                scenario: { title: 'Sea', index: 2 },
            },
            inlineSources: { autoJoin: { title: 'Sea', index: 2 }, scenario: { title: 'Sea', index: 2 } },
        }),
    );
    mockApi.getChallengeProfiles.mockResolvedValue({ Reset: {} });
    await open();
    await waitFor(() => expect(document.body.textContent).toContain('Reset (0)'));
    expect(cell('app.autoJoin').textContent).toContain('app.usingProfile');
    expect(cell('app.autoJoin').textContent).not.toContain('From rule');
    expect(cell('app.scenario').textContent).toContain('From rule: Sea');

    // Applying a manual profile suppresses Quad: now the later rule's own value is what runs.
    await choose(profileSelect('Reset'), 'Reset');
    fireEvent.click(screen.getByRole('button', { name: 'app.applyProfile' }));
    await waitFor(() => expect(cell('app.autoJoin').textContent).toContain('From rule: Sea'));
});

test('a rule without a title is named by its place in the list, in the UI language', async () => {
    mockTranslator.t.mockImplementation((key, vars) =>
        fillTemplate((lvApp as Record<string, string>)[key.replace('app.', '')] ?? key, vars),
    );
    mockApi.getTitleProfile.mockResolvedValue(
        titleRuleInfo({
            inlineValues: { scenario: 'Plan' },
            ruleSources: { scenario: { index: 3 } },
        }),
    );
    render(<ChallengeSettingsModal isOpen onClose={jest.fn()} challengeId="1" challengeTitle="Seaside" />);
    const label = await screen.findByText(lvApp.scenario);
    await waitFor(() => expect(label.closest('.rounded-box')!.textContent).toContain('No noteikuma: Nr. 3'));
});

test('a manual override wins over the rule value and says so', async () => {
    mockApi.getTitleProfile.mockResolvedValue(withRule());
    mockApi.getChallengeOverrides.mockResolvedValue({ scenario: '' });
    await open();
    expect(scenarioSelect().value).toBe('');
    expect(cell('app.scenario').textContent).toContain('app.overridden');
    expect(cell('app.scenario').textContent).not.toContain('From rule');
    expect(badge('app.scenario', 'app.overridden').className).toContain('badge-accent');
});

/** The saved-profiles dropdown (the scenario field is a select too), found by the profile it lists. */
const profileSelect = (name: string) =>
    screen
        .getAllByRole<HTMLSelectElement>('combobox')
        .find((select) => Array.from(select.options).some((option) => option.value === name))!;
const choose = async (select: HTMLSelectElement, value: string) =>
    act(async () => {
        select.value = value;
        select.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
const quadRule = () =>
    titleRuleInfo({
        profile: { name: 'Quad', values: { boostTime: 17 } },
        inlineValues: { scenario: 'Plan' },
        ruleSources: { scenario: { title: 'Seaside', index: 1 } },
    });

test('applying a manual profile keeps the values the rule sets directly, and saves only the suppression', async () => {
    mockApi.getTitleProfile.mockResolvedValue(quadRule());
    mockApi.getChallengeProfiles.mockResolvedValue({ Reset: {} });
    const { onClose } = await open();
    await waitFor(() => expect(document.body.textContent).toContain('Reset (0)'));

    await choose(profileSelect('Reset'), 'Reset');
    fireEvent.click(screen.getByRole('button', { name: 'app.applyProfile' }));

    await waitFor(() => expect(cell('app.boostTime').textContent).toContain('app.usingGlobal'));
    expect(scenarioSelect().value).toBe('Plan');
    expect(cell('app.scenario').textContent).toContain('From rule: Seaside');
    expect(document.body.textContent).not.toContain('app.usingProfile');
    fireEvent.click(screen.getByRole('button', { name: 'app.save' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(mockApi.replaceChallengeOverrides).toHaveBeenCalledWith('1', {}, true);
});

test("deleting the matched profile in the open modal keeps the rule's values", async () => {
    mockApi.getTitleProfile.mockResolvedValue(quadRule());
    mockApi.getChallengeProfiles.mockResolvedValue({ Quad: { boostTime: 17 } });
    await open();
    await waitFor(() => expect(document.body.textContent).toContain('Quad (1)'));
    expect(cell('app.boostTime').textContent).toContain('app.usingProfile');

    await choose(profileSelect('Quad'), 'Quad');
    await act(async () => invalid<void>(fireEvent.click(screen.getByRole('button', { name: 'app.deleteProfile' }))));
    // The settings, read again, hold the rule's own values and no profile.
    mockApi.getTitleProfile.mockResolvedValue(
        titleRuleInfo({
            inlineValues: { scenario: 'Plan' },
            ruleSources: { scenario: { title: 'Seaside', index: 1 } },
        }),
    );
    await act(async () => invalid<void>(fireEvent.click(screen.getByRole('button', { name: 'app.confirmDelete' }))));

    await waitFor(() => expect(cell('app.boostTime').textContent).toContain('app.usingGlobal'));
    expect(scenarioSelect().value).toBe('Plan');
    expect(cell('app.scenario').textContent).toContain('From rule: Seaside');
    expect(document.body.textContent).not.toContain('app.usingProfile');
});

test('saving with nothing changed stores no override: the rule values are not copied into the challenge', async () => {
    mockApi.getTitleProfile.mockResolvedValue(withRule());
    const { onClose } = await open();
    fireEvent.click(screen.getByRole('button', { name: 'app.save' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(mockApi.replaceChallengeOverrides).toHaveBeenCalledWith('1', {}, false);
});

test('choosing None over a rule-assigned scenario is a real override, and Clear all gives the rule back', async () => {
    mockApi.getTitleProfile.mockResolvedValue(withRule());
    await open();
    await choose(scenarioSelect(), '');
    expect(cell('app.scenario').textContent).toContain('app.overridden');
    fireEvent.click(screen.getByRole('button', { name: 'app.clearAll' }));
    await waitFor(() => expect(scenarioSelect().value).toBe('Plan'));
    expect(cell('app.scenario').textContent).toContain('From rule: Seaside');
});
