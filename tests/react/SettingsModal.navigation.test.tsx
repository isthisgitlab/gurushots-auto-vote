/**
 * The settings modal's section navigation on tabs, driven through the real hooks (only
 * window.api is mocked): the tab row, the filter, the focus after a refused Save and the
 * default navigation the shared cells see outside the modal. Nothing is unmounted to hide a
 * section (that would drop a scenario draft or a title-rule edit the unsaved-changes guard
 * still counts): an inactive or filtered-out tab and panel carry the `hidden` attribute.
 */

import { act, fireEvent, render, screen, waitFor } from './helpers/test-utils';
import { SettingsModal } from '@/components/app/SettingsModal';
import { SettingsSectionPanel } from '@/components/app/SettingsSectionPanel';
import { SETTINGS_NAV_SCROLL_PADDING } from '@/components/app/SettingsNavBar';
import { settingsPanelId, settingsTabId, useSettingsNav } from '@/contexts/SettingsNavContext';
import { selectTab } from '../helpers/selectTab';
import { fireSettingsChanged, mockApi } from './helpers/setup';
import { invalid } from '../helpers/invalid';

const APP_SETTINGS = { theme: 'light', language: 'en', timezone: 'Europe/Riga' };

// Label keys with accents stand in for translated text: an unknown key is shown as it is.
const SCHEMA = {
    exposure: {
        type: 'number',
        default: 70,
        label: 'Ekspozīcija',
        description: 'How much of the challenge to vote on, about',
        group: 'gCore',
        perChallenge: true,
    },
    retries: {
        type: 'number',
        default: 3,
        label: 'Retries',
        description: 'Attempts before giving up',
        group: 'gCore',
        perChallenge: true,
    },
    badges: {
        type: 'boolean',
        default: true,
        label: 'Badges',
        description: 'Show the badge row, turbo',
        group: 'gExtra',
        perChallenge: true,
    },
    missionTurbo: {
        type: 'boolean',
        default: false,
        label: 'Mission turbo',
        description: 'Spend turbo on missions',
        group: 'gApp',
    },
};

const onClose = jest.fn();

const scrollIntoView = jest.fn<void, [ScrollIntoViewOptions]>();
const rect = (top: number): DOMRect => ({
    top,
    bottom: top,
    left: 0,
    right: 0,
    width: 0,
    height: 0,
    x: 0,
    y: 0,
    toJSON: () => rect(top),
});
// The panel-scroll stubs, with the hook test's figures (useScrollPanelIntoView.test.tsx):
// happy-dom measures zero rects, so the box's visible top is stubbed to 100 and a panel top
// to 60 (the box is matched by its class here).
const stubScrollRects = () => {
    jest.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
        return rect(this.classList.contains('modal-box') ? 100 : 60);
    });
};
const tabs = () => screen.queryAllByRole('tab');
const tabNames = () => tabs().map((tab) => tab.textContent);
const activeTab = () => tabs().find((tab) => tab.getAttribute('aria-selected') === 'true') as HTMLElement;
const panelOf = (name: string | RegExp) => screen.getByRole('tabpanel', { name });
// The cells hide with the `hidden` class, the tabs and panels with the attribute; both count.
const isHidden = (element: Element | null) =>
    element !== null && (element.classList.contains('hidden') || element.hasAttribute('hidden'));
const cellOf = (inputId: string) => document.getElementById(inputId)!.closest('.rounded-box') as HTMLElement;
const filterInput = () => screen.getByRole<HTMLInputElement>('searchbox');
const typeFilter = (value: string) => fireEvent.input(filterInput(), { target: { value } });
const save = () => fireEvent.click(screen.getByRole('button', { name: 'app.save' }));

beforeEach(() => {
    window.HTMLElement.prototype.scrollIntoView = scrollIntoView;
    scrollIntoView.mockReset();
    window.api = invalid(mockApi);
    document.documentElement.setAttribute('data-theme', 'light');
    onClose.mockReset();
    mockApi.getSettings.mockReset().mockResolvedValue(invalid({ app: { ...APP_SETTINGS } }));
    mockApi.getSettingsSchema.mockReset().mockResolvedValue(
        invalid({
            schema: SCHEMA,
            defaults: { exposure: 70, retries: 3, badges: true, missionTurbo: false },
            groups: [
                { id: 'gCore', label: 'Core group', tier: 'core' },
                { id: 'gExtra', label: 'Extra group', tier: 'extra' },
                { id: 'gApp', label: 'Missions group', tier: 'app' },
            ],
            tiers: [
                { id: 'core', label: 'app.tierCore' },
                { id: 'extra', label: 'app.tierExtra' },
                { id: 'app', label: 'app.tierApp' },
            ],
        }),
    );
    mockApi.setSetting.mockReset().mockResolvedValue(true);
    mockApi.setGlobalDefault.mockReset().mockResolvedValue(true);
    mockApi.getTitleRules.mockReset().mockResolvedValue(invalid([]));
    mockApi.setTitleRules.mockReset().mockResolvedValue(true);
    mockApi.getChallengeProfiles.mockReset().mockResolvedValue({});
    mockApi.getScenarios.mockReset().mockResolvedValue(invalid({ success: true, scenarios: {}, templates: [] }));
    mockApi.getTitleProfile.mockReset().mockResolvedValue(null);
    mockApi.getChallengeOverrides.mockReset().mockResolvedValue({});
    mockApi.replaceChallengeOverrides.mockReset().mockResolvedValue(true);
    mockApi.getImportReport.mockReset().mockResolvedValue(invalid(undefined));
    window.api.checkScenario = invalid(jest.fn(async () => ({ success: true })));
    window.api.saveScenario = invalid(jest.fn(async () => ({ success: true })));
});

const openSettings = async () => {
    const view = render(<SettingsModal isOpen onClose={onClose} />);
    await waitFor(() => expect(document.getElementById('setting-exposure')).not.toBeNull());
    return view;
};

describe('SettingsModal — tabs', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    test('Application is active first, then the tier bands, then the fixed tabs; the app tier is no tab', async () => {
        await openSettings();
        expect(tabNames()).toEqual([
            'app.applicationSettings',
            'app.tierCore',
            'app.tierExtra',
            'app.titleTagRules',
            'app.scenarios',
        ]);
        expect(activeTab().textContent).toBe('app.applicationSettings');
        expect(screen.queryByRole('tab', { name: 'app.tierApp' })).toBeNull();
        // The app tier's group renders inside the Application panel, below its hand-written cells.
        expect(document.getElementById('setting-missionTurbo')).not.toBeNull();
        // Tab and panel join through the settings- prefixed ids, so the two modals'
        // DOM ids cannot collide while both are mounted.
        expect(activeTab().id).toBe(settingsTabId('application'));
        expect(panelOf('app.applicationSettings').id).toBe(settingsPanelId('application'));
        // The other panels are hidden, not unmounted.
        expect(document.getElementById(settingsPanelId('tier-core'))!.hasAttribute('hidden')).toBe(true);
        expect(document.getElementById('setting-exposure')).not.toBeNull();
    });

    test('selecting a tab shows its panel, keeps the others mounted and scrolls the row only then', async () => {
        await openSettings();
        scrollIntoView.mockClear();

        selectTab('app.tierExtra');
        expect(activeTab().textContent).toBe('app.tierExtra');
        expect(panelOf('app.tierExtra').hasAttribute('hidden')).toBe(false);
        expect(document.getElementById(settingsPanelId('application'))!.hasAttribute('hidden')).toBe(true);
        expect(document.getElementById('setting-missionTurbo')).not.toBeNull();
        // A selection scrolls the tab into the row.
        expect(scrollIntoView).toHaveBeenCalledTimes(1);
        expect(scrollIntoView.mock.instances[0]).toBe(screen.getByRole('tab', { name: 'app.tierExtra' }));

        // Clicking the already-active tab neither re-selects nor scrolls.
        fireEvent.click(screen.getByRole('tab', { name: 'app.tierExtra' }));
        expect(activeTab().textContent).toBe('app.tierExtra');
        expect(scrollIntoView).toHaveBeenCalledTimes(1);
    });

    test('a user selection scrolls the modal box so the panel clears the bar; a filter-driven move does not', async () => {
        await openSettings();
        const box = document.querySelector<HTMLElement>('.modal-box')!;
        stubScrollRects();
        box.scrollTop = 200;

        selectTab('app.tierExtra');
        // target = 60 - 100 + 200, the bar's offsetHeight being 0 under happy-dom: the
        // panel top clears the bar.
        expect(box.scrollTop).toBe(160);

        // A derived move is no user selection: it never asks for a scroll.
        typeFilter('zzzz');
        expect(box.scrollTop).toBe(160);
    });

    test('a tab switch after a refused Save’s reveal still scrolls the modal box', async () => {
        mockApi.setGlobalDefault.mockResolvedValue(false);
        await openSettings();
        const box = document.querySelector<HTMLElement>('.modal-box')!;
        stubScrollRects();
        box.scrollTop = 200;

        // A first user selection asks for the panel the test selects again after the reveal:
        // a repeat ask for the same id must scroll (a dedupe by panel id would drop it).
        selectTab('app.tierExtra');
        expect(box.scrollTop).toBe(160);
        box.scrollTop = 200;

        // The reveal (the refused key's programmatic move) selects the tab without scrolling;
        // the input sits in the still-hidden tier panel, mounted like every panel.
        fireEvent.change(document.getElementById('setting-exposure')!, { target: { value: '80' } });
        save();
        await screen.findByText('app.settingsSaveError');
        expect(activeTab().textContent).toBe('app.tierCore app.tabHasErrors');
        expect(box.scrollTop).toBe(200);

        // The next user selection scrolls again: every request is one-shot.
        selectTab('app.tierExtra');
        expect(box.scrollTop).toBe(160);
    });

    test('a tab switch after a reopen still scrolls the modal box', async () => {
        const { rerender } = await openSettings();
        // The selection before the close has already asked for the panel once: the reopened
        // modal must not remember that ask — the same id is selectable and scrolls again.
        selectTab('app.tierExtra');
        rerender(<SettingsModal isOpen={false} onClose={onClose} />);
        rerender(<SettingsModal isOpen onClose={onClose} />);
        await waitFor(() => expect(document.getElementById('setting-exposure')).not.toBeNull());

        stubScrollRects();
        const box = document.querySelector<HTMLElement>('.modal-box')!;
        box.scrollTop = 200;
        selectTab('app.tierExtra');
        expect(box.scrollTop).toBe(160);
    });

    test('reopening the modal lands on Application with no filter', async () => {
        const { rerender } = await openSettings();
        selectTab('app.tierExtra');
        typeFilter('ekspozicija');
        rerender(<SettingsModal isOpen={false} onClose={onClose} />);
        rerender(<SettingsModal isOpen onClose={onClose} />);
        await waitFor(() => expect(document.getElementById('setting-exposure')).not.toBeNull());

        expect(filterInput().value).toBe('');
        expect(activeTab().textContent).toBe('app.applicationSettings');
        expect(tabNames()).toHaveLength(5);
    });

    test('the bar keeps its sticky treatment and the box its height and scroll padding', async () => {
        await openSettings();
        const box = document.querySelector('.modal-box')!;
        for (const name of SETTINGS_NAV_SCROLL_PADDING.split(' ')) expect(box.classList.contains(name)).toBe(true);
        // The fixed box height keeps a short tab from shrinking and re-centring it.
        expect(box.classList.contains('h-[calc(100vh-5em)]')).toBe(true);
        expect(box.classList.contains('flex')).toBe(true);
        expect(box.classList.contains('flex-col')).toBe(true);
        const bar = filterInput().closest('.sticky')!;
        expect(bar.classList.contains('-top-6')).toBe(true);
        expect(bar.classList.contains('z-10')).toBe(true);
        expect(bar.closest('.modal-box')).toBe(box);
        // The footer carries the className the modal passes it: mt-auto pins it to a short tab's bottom.
        expect(document.querySelector('.modal-box > .sticky.mt-auto')).not.toBeNull();
    });

    test('the tab row scrolls on phones, wraps between sm and xl, and is one line from xl', async () => {
        await openSettings();
        const row = screen.getByRole('tablist', { name: 'app.settingsJumpLabel' });
        // Phones: the single scrolling line.
        expect(row.classList.contains('flex-nowrap')).toBe(true);
        expect(row.classList.contains('overflow-x-auto')).toBe(true);
        // Mid widths: the row wraps, so all seven labels stay on screen.
        expect(row.classList.contains('sm:flex-wrap')).toBe(true);
        expect(row.classList.contains('sm:overflow-x-visible')).toBe(true);
        // From xl: one scrolling line beside the filter again.
        expect(row.classList.contains('xl:flex-nowrap')).toBe(true);
        expect(row.classList.contains('xl:overflow-x-auto')).toBe(true);
        expect(tabs()).toHaveLength(5);
    });
});

describe('SettingsModal — filter', () => {
    // spellcheck={false} is not asserted: happy-dom has no `spellcheck` property, so Preact drops the attribute there.
    test('the field is a search box that does not autocomplete', async () => {
        await openSettings();
        const input = filterInput();
        expect(input.getAttribute('autocomplete')).toBe('off');
        expect(input.getAttribute('placeholder')).toBe('app.settingsFilterPlaceholder');
    });

    test('a filter hides the tabs without a match and moves the active tab without scrolling', async () => {
        await openSettings();
        scrollIntoView.mockClear();
        typeFilter('ekspozicija');

        expect(tabNames()).toEqual(['app.tierCore']);
        // The hidden selection is replaced by the first tab that still matches.
        expect(activeTab().textContent).toBe('app.tierCore');
        expect(panelOf('app.tierCore').hasAttribute('hidden')).toBe(false);
        // A derived move never yanks the row.
        expect(scrollIntoView).not.toHaveBeenCalled();

        // Cells inside the surviving panel filter as now; the other panel hides whole.
        expect(isHidden(cellOf('setting-exposure'))).toBe(false);
        expect(isHidden(cellOf('setting-retries'))).toBe(true);
        expect(document.getElementById(settingsPanelId('tier-extra'))!.hasAttribute('hidden')).toBe(true);
        expect(document.getElementById('setting-badges')).not.toBeNull();
    });

    test('matches a description', async () => {
        await openSettings();
        typeFilter('giving up');
        expect(isHidden(cellOf('setting-retries'))).toBe(false);
        expect(isHidden(cellOf('setting-exposure'))).toBe(true);
    });

    test('matches the hand-written Application cells and the app-tier groups', async () => {
        await openSettings();
        typeFilter('app.timezoneDesc');
        expect(tabNames()).toEqual(['app.applicationSettings']);
        expect(isHidden(cellOf('ui-timezone'))).toBe(false);
        expect(isHidden(cellOf('ui-theme'))).toBe(true);

        typeFilter('mission');
        expect(tabNames()).toEqual(['app.applicationSettings']);
        expect(isHidden(cellOf('setting-missionTurbo'))).toBe(false);
        expect(isHidden(cellOf('ui-timezone'))).toBe(true);
    });

    test('the tabs without settings match on their heading', async () => {
        await openSettings();
        typeFilter('scenarios');
        expect(tabNames()).toEqual(['app.scenarios']);
        expect(panelOf('app.scenarios').hasAttribute('hidden')).toBe(false);
        typeFilter('titleTag');
        expect(tabNames()).toEqual(['app.titleTagRules']);
    });

    test('the about filter shows the Application tab with only the About and data block', async () => {
        await openSettings();
        typeFilter('about');
        expect(tabNames()).toEqual(['app.applicationSettings']);
        expect(panelOf('app.applicationSettings').hasAttribute('hidden')).toBe(false);
        expect(isHidden(cellOf('ui-timezone'))).toBe(true);
        expect(isHidden(cellOf('setting-missionTurbo'))).toBe(true);
        const aboutBlock = screen.getByText('about.title').parentElement as HTMLElement;
        expect(isHidden(aboutBlock)).toBe(false);
    });

    test('a description word loses to a name match anywhere ("about" finds the About block, not the exposure text)', async () => {
        // "about" is in the exposure description, but the About block's heading is a name — and one
        // name match anywhere silences the description search in every tab.
        await openSettings();
        typeFilter('about');
        expect(tabNames()).toEqual(['app.applicationSettings']);
        expect(document.getElementById(settingsPanelId('tier-core'))!.hasAttribute('hidden')).toBe(true);
    });

    test('a name match anywhere silences description matches, until no name matches', async () => {
        await openSettings();
        // "turbo" matches the name "Mission turbo", so the badges description ("turbo") is not searched.
        typeFilter('turbo');
        expect(tabNames()).toEqual(['app.applicationSettings']);
        expect(isHidden(cellOf('setting-missionTurbo'))).toBe(false);
        expect(isHidden(cellOf('setting-badges'))).toBe(true);
        expect(document.getElementById(settingsPanelId('tier-extra'))!.hasAttribute('hidden')).toBe(true);

        // No name contains "giving up", so descriptions are searched and Retries is found again.
        typeFilter('giving up');
        expect(isHidden(cellOf('setting-retries'))).toBe(false);
        expect(isHidden(cellOf('setting-exposure'))).toBe(true);
    });

    test('a group label shows the whole group, and a tier tab label the whole tab', async () => {
        await openSettings();
        typeFilter('Core group');
        expect(tabNames()).toEqual(['app.tierCore']);
        expect(isHidden(cellOf('setting-exposure'))).toBe(false);
        expect(isHidden(cellOf('setting-retries'))).toBe(false);

        typeFilter('tierExtra');
        expect(tabNames()).toEqual(['app.tierExtra']);
        expect(isHidden(cellOf('setting-badges'))).toBe(false);
    });

    test('a query matching the Application title and another tab’s setting shows all of one, only the match in the other', async () => {
        await openSettings();
        // "ic" is in the Application tab's own title and in the exposure setting's name. The only
        // other name holding it (the licenses button) sits in the Application tab, whose title
        // match already shows all of it — the point is that no Core or Extra name contains it.
        typeFilter('ic');
        expect(tabNames()).toEqual(['app.applicationSettings', 'app.tierCore']);
        // The title match shows every Application cell, group and the About block, including the
        // ones whose own names have no "ic".
        expect(isHidden(cellOf('ui-theme'))).toBe(false);
        expect(isHidden(cellOf('setting-missionTurbo'))).toBe(false);
        const aboutBlock = screen.getByText('about.title').parentElement as HTMLElement;
        expect(isHidden(aboutBlock)).toBe(false);
        // Core, whose title does not match, shows only the setting whose name matches.
        selectTab('app.tierCore');
        expect(panelOf('app.tierCore').hasAttribute('hidden')).toBe(false);
        expect(isHidden(cellOf('setting-exposure'))).toBe(false);
        expect(isHidden(cellOf('setting-retries'))).toBe(true);
    });

    test('the Application tab title shows all its content', async () => {
        await openSettings();
        typeFilter('app.applicationSettings');
        expect(tabNames()).toEqual(['app.applicationSettings']);
        expect(isHidden(cellOf('ui-theme'))).toBe(false);
        expect(isHidden(cellOf('setting-missionTurbo'))).toBe(false);
        const aboutBlock = screen.getByText('about.title').parentElement as HTMLElement;
        expect(isHidden(aboutBlock)).toBe(false);
    });

    test('a hand-written cell is found through its field labels', async () => {
        await openSettings();
        typeFilter('app.apiRetryBaseDelayMs');
        expect(tabNames()).toEqual(['app.applicationSettings']);
        // The group cells' inputs carry their field label, and the cell is the input's rounded box.
        const reliability = screen.getByLabelText('app.apiRetryBaseDelayMs').closest('.rounded-box') as HTMLElement;
        expect(isHidden(reliability)).toBe(false);
        const checkFrequency = screen.getByLabelText('app.checkFrequencyMin').closest('.rounded-box') as HTMLElement;
        expect(isHidden(checkFrequency)).toBe(true);
    });

    test('the import heading is a name only while a report is shown', async () => {
        mockApi.getImportReport.mockResolvedValue(
            invalid({
                success: true,
                report: { at: '2026-10-16T09:00:00.000Z', refsBlocked: [], acknowledged: true },
            }),
        );
        await openSettings();
        await screen.findByRole('heading', { name: 'about.importTitle' });

        typeFilter('about.importTitle');
        expect(tabNames()).toEqual(['app.applicationSettings']);
        const aboutBlock = screen.getByText('about.title').parentElement as HTMLElement;
        expect(isHidden(aboutBlock)).toBe(false);
    });

    test('without a report the import heading matches nothing', async () => {
        await openSettings();
        typeFilter('about.importTitle');
        expect(tabNames()).toHaveLength(0);
        expect(screen.getByText('app.settingsNoMatch')).toBeTruthy();
    });

    test('a closed modal does not read the import report', () => {
        render(<SettingsModal isOpen={false} onClose={onClose} />);
        expect(mockApi.getImportReport).not.toHaveBeenCalled();
    });

    test('a blank filter is no filter', async () => {
        await openSettings();
        typeFilter('   ');
        expect(tabNames()).toHaveLength(5);
        expect(isHidden(cellOf('setting-exposure'))).toBe(false);
    });

    test('clearing the filter keeps the tab it had moved to', async () => {
        await openSettings();
        selectTab('app.scenarios');
        typeFilter('ekspozicija');
        expect(activeTab().textContent).toBe('app.tierCore');
        typeFilter('');

        expect(tabNames()).toHaveLength(5);
        expect(activeTab().textContent).toBe('app.tierCore');
        expect(document.querySelectorAll('[role="tabpanel"][hidden]')).toHaveLength(4);
    });

    test('with no match anywhere it says so, and Clear restores a focusable tab', async () => {
        await openSettings();
        typeFilter('zzzz');
        expect(screen.getByText('app.settingsNoMatch')).toBeTruthy();
        expect(tabs()).toHaveLength(0);
        expect(screen.queryByRole('tabpanel')).toBeNull();

        fireEvent.click(screen.getByRole('button', { name: 'app.settingsFilterClear' }));
        expect(screen.queryByText('app.settingsNoMatch')).toBeNull();
        expect(filterInput().value).toBe('');
        expect(tabs()).toHaveLength(5);
        expect(activeTab().getAttribute('tabindex')).toBe('0');
    });

    test('a schema refetch re-evaluating the filter still leaves one visible panel and one focusable tab', async () => {
        await openSettings();
        typeFilter('ekspozicija');
        expect(tabNames()).toEqual(['app.tierCore']);

        // The refetched schema no longer has Core: the same filter text matches Extra only.
        mockApi.getSettingsSchema.mockResolvedValue(
            invalid({
                schema: {
                    exposureAlt: {
                        type: 'number',
                        default: 70,
                        label: 'Ekspozīcija',
                        description: 'Moved with the band',
                        group: 'gExtra',
                        perChallenge: true,
                    },
                },
                defaults: { exposureAlt: 70 },
                groups: [{ id: 'gExtra', label: 'Extra group', tier: 'extra' }],
                tiers: [{ id: 'extra', label: 'app.tierExtra' }],
            }),
        );
        act(() => fireSettingsChanged());

        await waitFor(() => expect(tabNames()).toEqual(['app.tierExtra']));
        expect(activeTab().textContent).toBe('app.tierExtra');
        expect(screen.getAllByRole('tabpanel')).toHaveLength(1);
        expect(activeTab().getAttribute('tabindex')).toBe('0');
    });

    test('a schema refetch removing the selected tier falls back to the first shown tab', async () => {
        await openSettings();
        // The user selected Extra; the filter then hides it in favour of Core, and the refetch
        // removes Extra outright — the selection no longer names any section the modal renders.
        selectTab('app.tierExtra');
        typeFilter('ekspozicija');
        expect(tabNames()).toEqual(['app.tierCore']);
        mockApi.getSettingsSchema.mockResolvedValue(
            invalid({
                schema: {
                    exposure: {
                        type: 'number',
                        default: 70,
                        label: 'Ekspozīcija',
                        description: 'Stayed with the band',
                        group: 'gCore',
                        perChallenge: true,
                    },
                },
                defaults: { exposure: 70 },
                groups: [{ id: 'gCore', label: 'Core group', tier: 'core' }],
                tiers: [{ id: 'core', label: 'app.tierCore' }],
            }),
        );
        act(() => fireSettingsChanged());

        // Wait for a state only the refetch produces before reading the active tab. The stale
        // selected tab also drives sectionTexts' unknown-id arm (`index === -1`).
        await waitFor(() => expect(document.getElementById(settingsPanelId('tier-extra'))).toBeNull());
        // A hidden tab is never the active one: the first shown one takes over.
        expect(tabNames()).toEqual(['app.tierCore']);
        expect(activeTab().textContent).toBe('app.tierCore');
        expect(panelOf('app.tierCore').hasAttribute('hidden')).toBe(false);
    });

    test('staged values of hidden tabs are still saved', async () => {
        await openSettings();
        fireEvent.change(document.getElementById('setting-exposure')!, { target: { value: '80' } });
        typeFilter('turbo');
        expect(document.getElementById(settingsPanelId('tier-core'))!.hasAttribute('hidden')).toBe(true);

        save();
        await waitFor(() => expect(mockApi.setGlobalDefault).toHaveBeenCalledWith('exposure', 80));
    });
});

describe('SettingsModal — a draft survives tab switches and hiding', () => {
    test('a draft keeps its field across tabs and a filter, and Save still prompts', async () => {
        await openSettings();
        selectTab('app.scenarios');
        fireEvent.click(await screen.findByRole('button', { name: 'app.sbNew' }));
        await screen.findByLabelText('app.sbName');
        fireEvent.change(screen.getByLabelText('app.sbName'), { target: { value: 'Draft' } });
        const field = screen.getByLabelText<HTMLInputElement>('app.sbName');

        typeFilter('ekspozicija');
        expect(document.getElementById(settingsPanelId('scenarios'))!.hasAttribute('hidden')).toBe(true);
        typeFilter('');
        selectTab('app.applicationSettings');
        selectTab('app.scenarios');

        expect(screen.getByLabelText<HTMLInputElement>('app.sbName')).toBe(field);
        expect(field.value).toBe('Draft');
        save();
        expect(screen.getByText('app.settingsDropScenario')).toBeTruthy();
        expect(mockApi.setGlobalDefault).not.toHaveBeenCalled();
    });
});

describe('SettingsModal — a refused Save selects and marks the tabs', () => {
    test('the first refused key selects its tab, both tabs are marked, and the input takes focus', async () => {
        mockApi.setSetting.mockResolvedValue(false);
        mockApi.setGlobalDefault.mockResolvedValue(false);
        await openSettings();
        selectTab('app.tierCore');
        fireEvent.change(document.getElementById('setting-exposure')!, { target: { value: '80' } });
        selectTab('app.applicationSettings');
        act(() => {
            const theme = document.getElementById('ui-theme') as HTMLSelectElement;
            theme.value = 'dark';
            theme.dispatchEvent(new window.Event('change', { bubbles: true }));
        });

        save();
        await screen.findByText('app.settingsSaveError');
        // commit() writes the UI keys first, so Application is the first refused section.
        expect(activeTab().textContent).toBe('app.applicationSettings app.tabHasErrors');
        await waitFor(() => expect(document.activeElement).toBe(document.getElementById('ui-theme')));
        // Both refused tabs carry the marker in their accessible name.
        screen.getByRole('tab', { name: 'app.applicationSettings app.tabHasErrors' });
        screen.getByRole('tab', { name: 'app.tierCore app.tabHasErrors' });
        expect(document.getElementById('setting-exposure')!.getAttribute('aria-invalid')).toBe('true');
    });

    test('fixing a value leaves the marks in place until the next Save clears the fixed one', async () => {
        mockApi.setGlobalDefault.mockResolvedValue(false);
        await openSettings();
        selectTab('app.tierCore');
        fireEvent.change(document.getElementById('setting-exposure')!, { target: { value: '80' } });
        selectTab('app.applicationSettings');
        fireEvent.click(document.getElementById('setting-missionTurbo')!);

        save();
        await screen.findByText('app.settingsSaveError');
        expect(activeTab().textContent).toBe('app.tierCore app.tabHasErrors');
        screen.getByRole('tab', { name: 'app.tierCore app.tabHasErrors' });
        screen.getByRole('tab', { name: 'app.applicationSettings app.tabHasErrors' });

        // Editing the refused value marks nothing away by itself.
        fireEvent.change(document.getElementById('setting-exposure')!, { target: { value: '90' } });
        expect(screen.getByRole('tab', { name: 'app.tierCore app.tabHasErrors' })).toBeTruthy();
        expect(document.getElementById('setting-exposure')!.getAttribute('aria-invalid')).toBe('true');

        // The next Save clears the fixed key's marks; the unfixed tab keeps its own.
        mockApi.setGlobalDefault.mockImplementation(async (key: string) => key !== 'missionTurbo');
        save();
        await screen.findByText('app.settingsSaveError');
        expect(screen.queryByRole('tab', { name: 'app.tierCore app.tabHasErrors' })).toBeNull();
        screen.getByRole('tab', { name: 'app.applicationSettings app.tabHasErrors' });
        expect(document.getElementById('setting-exposure')!.hasAttribute('aria-invalid')).toBe(false);
        await waitFor(() => expect(document.activeElement).toBe(document.getElementById('setting-missionTurbo')));
    });

    test('a refused key in a hidden tab clears the filter and reveals the tab', async () => {
        mockApi.setGlobalDefault.mockResolvedValue(false);
        await openSettings();
        selectTab('app.tierCore');
        fireEvent.change(document.getElementById('setting-exposure')!, { target: { value: '80' } });
        scrollIntoView.mockClear();
        typeFilter('zzzz');
        expect(tabs()).toHaveLength(0);

        save();
        await screen.findByText('app.settingsSaveError');
        const input = document.getElementById('setting-exposure')!;
        await waitFor(() => expect(document.activeElement).toBe(input));
        expect(filterInput().value).toBe('');
        expect(activeTab().textContent).toBe('app.tierCore app.tabHasErrors');
        expect(input.getAttribute('aria-invalid')).toBe('true');
        // The reveal scrolls the tab into the row like a selection.
        expect(scrollIntoView).toHaveBeenCalled();
    });

    test('refused title rules select their tab and focus the tab button', async () => {
        mockApi.setTitleRules.mockResolvedValue(false);
        await openSettings();
        selectTab('app.titleTagRules');
        fireEvent.click(await screen.findByRole('button', { name: 'app.addTitleTagRule' }));
        typeFilter('zzzz');

        save();
        await screen.findByText('app.titleTagRulesSaveError');
        const tab = screen.getByRole('tab', { name: 'app.titleTagRules' });
        await waitFor(() => expect(document.activeElement).toBe(tab));
        expect(filterInput().value).toBe('');
    });

    test('a refused language save selects Application and focuses its tab button', async () => {
        mockApi.setSetting.mockResolvedValue(false);
        await openSettings();
        act(() => {
            const language = document.getElementById('ui-language') as HTMLSelectElement;
            language.value = 'lv';
            language.dispatchEvent(new window.Event('change', { bubbles: true }));
        });

        save();
        await screen.findByText('app.settingsSaveError');
        const tab = screen.getByRole('tab', { name: 'app.applicationSettings' });
        await waitFor(() => expect(document.activeElement).toBe(tab));
        expect(activeTab().textContent).toBe('app.applicationSettings');
    });

    test('a refused Save whose input is gone by focus time still selects the tab', async () => {
        mockApi.setGlobalDefault.mockResolvedValue(false);
        await openSettings();
        selectTab('app.tierCore');
        const input = document.getElementById('setting-exposure')!;
        fireEvent.change(input, { target: { value: '80' } });
        input.remove();

        save();
        await screen.findByText('app.settingsSaveError');
        expect(activeTab().textContent).toBe('app.tierCore app.tabHasErrors');
        expect(onClose).not.toHaveBeenCalled();
    });
});

describe('SettingsModal — a refused Save marks what was refused', () => {
    test('an out-of-range UI number is refused on Save, not saved as the in-range value typed on the way', async () => {
        // The handler's own bounds (settings/loadValidation.ts): a write outside them, or no number, is refused.
        mockApi.setSetting.mockImplementation(
            async (_key: string, value: unknown) => typeof value === 'number' && value >= 0 && value <= 10,
        );
        await openSettings();
        const retries = screen.getByLabelText<HTMLInputElement>('app.apiMaxRetries');
        fireEvent.change(retries, { target: { value: '1' } });
        fireEvent.change(retries, { target: { value: '15' } });
        expect(retries.value).toBe('15');
        expect(screen.getByText('app.validationOutOfRange')).toBeTruthy();

        save();
        await screen.findByText('app.settingsSaveError');
        expect(onClose).not.toHaveBeenCalled();
        expect(mockApi.setSetting).toHaveBeenCalledWith('apiMaxRetries', 15);
        expect(mockApi.setSetting).not.toHaveBeenCalledWith('apiMaxRetries', 1);
        expect(retries.getAttribute('aria-invalid')).toBe('true');
        expect(retries.getAttribute('aria-describedby')).toBe(screen.getByText('app.validationOutOfRange').id);
        await waitFor(() => expect(document.activeElement).toBe(retries));
        // The draft stays for the user to correct, and a corrected one saves.
        expect(retries.value).toBe('15');
        fireEvent.change(retries, { target: { value: '4' } });
        save();
        await waitFor(() => expect(onClose).toHaveBeenCalled());
        expect(mockApi.setSetting).toHaveBeenLastCalledWith('apiMaxRetries', 4);
    });

    test('an emptied UI number is refused on Save too', async () => {
        mockApi.setSetting.mockImplementation(async (_key: string, value: unknown) => Number.isFinite(value));
        await openSettings();
        const retries = screen.getByLabelText<HTMLInputElement>('app.apiMaxRetries');
        fireEvent.change(retries, { target: { value: '' } });

        save();
        await screen.findByText('app.settingsSaveError');
        expect(onClose).not.toHaveBeenCalled();
        expect(mockApi.setSetting).toHaveBeenCalledWith('apiMaxRetries', Number.NaN);
        expect(retries.getAttribute('aria-invalid')).toBe('true');
        await waitFor(() => expect(document.activeElement).toBe(retries));
    });

    test('a refused schedule marks its inputs invalid and its group points at the save-failed alert', async () => {
        mockApi.getSettingsSchema.mockResolvedValue(
            invalid({
                schema: {
                    ...SCHEMA,
                    autoSubmitSchedule: { type: 'schedule', default: [], label: 'Schedule', group: 'gCore' },
                },
                defaults: { exposure: 70, retries: 3, badges: true, missionTurbo: false, autoSubmitSchedule: [] },
                groups: [{ id: 'gCore', label: 'Core group', tier: 'core' }],
                tiers: [{ id: 'core', label: 'Core band' }],
            }),
        );
        mockApi.setGlobalDefault.mockResolvedValue(false);
        await openSettings();
        const hours = screen.getByLabelText<HTMLInputElement>('app.autoSubmitScheduleImage 2 app.hours');
        expect(hours.hasAttribute('aria-invalid')).toBe(false);
        fireEvent.change(hours, { target: { value: '2' } });

        save();
        const alert = await screen.findByText('app.settingsSaveError');
        const group = document.getElementById('setting-autoSubmitSchedule')!;
        await waitFor(() => expect(document.activeElement).toBe(group));
        for (const count of [2, 3, 4]) {
            for (const unit of ['app.hours', 'app.minutes']) {
                const input = screen.getByLabelText(`app.autoSubmitScheduleImage ${count} ${unit}`);
                expect(input.getAttribute('aria-invalid')).toBe('true');
            }
        }
        // The group itself cannot carry aria-invalid: it names the alert instead.
        expect(group.hasAttribute('aria-invalid')).toBe(false);
        expect(group.getAttribute('aria-describedby')).toBe(alert.closest('[role="alert"]')!.id);
    });
});

describe('SettingsModal — Escape belongs to the field that has something to undo', () => {
    test('Escape in the filter clears its text and leaves the modal open; with no text it closes the modal', async () => {
        await openSettings();
        typeFilter('zzzz');
        expect(filterInput().value).toBe('zzzz');

        fireEvent.keyDown(filterInput(), { key: 'Escape' });
        expect(filterInput().value).toBe('');
        expect(onClose).not.toHaveBeenCalled();

        fireEvent.keyDown(filterInput(), { key: 'Escape' });
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    test('other keys in the filter are left to the modal and the field', async () => {
        await openSettings();
        typeFilter('zzzz');
        fireEvent.keyDown(filterInput(), { key: 'a' });
        expect(filterInput().value).toBe('zzzz');
        expect(onClose).not.toHaveBeenCalled();
    });

    test('Escape in the open custom-timezone field closes the field only', async () => {
        await openSettings();
        fireEvent.click(screen.getByRole('button', { name: 'app.addCustomTimezone' }));
        const input = screen.getByRole<HTMLInputElement>('textbox', { name: 'app.addCustomTimezone' });

        fireEvent.keyDown(input, { key: 'Escape' });
        expect(screen.queryByRole('textbox', { name: 'app.addCustomTimezone' })).toBeNull();
        expect(onClose).not.toHaveBeenCalled();

        fireEvent.keyDown(document.body, { key: 'Escape' });
        expect(onClose).toHaveBeenCalledTimes(1);
    });
});

describe('the default navigation (outside the settings modal)', () => {
    test('shows everything with Application active, and its actions do nothing', () => {
        function Probe() {
            const nav = useSettingsNav();
            nav.select('scenarios');
            nav.setQuery('x');
            nav.reveal('scenarios');
            nav.reset();
            return <p>{`${nav.query}|${nav.isShown('scenarios')}|${nav.active}`}</p>;
        }
        render(<Probe />);
        expect(screen.getByText('|true|application')).toBeTruthy();
    });

    test('a panel outside the modal is only visible on the default active tab', () => {
        render(
            <>
                <SettingsSectionPanel id="application" title="app.applicationSettings">
                    <p>application</p>
                </SettingsSectionPanel>
                <SettingsSectionPanel id="scenarios" title="app.scenarios">
                    <p>scenarios</p>
                </SettingsSectionPanel>
            </>,
        );
        expect(document.getElementById(settingsPanelId('application'))!.hasAttribute('hidden')).toBe(false);
        expect(document.getElementById(settingsPanelId('scenarios'))!.hasAttribute('hidden')).toBe(true);
    });
});
