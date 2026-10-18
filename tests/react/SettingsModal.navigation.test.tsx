/**
 * The settings modal's section navigation, driven through the real hooks (only window.api is mocked): the
 * collapsible sections, the jump buttons, the filter and the focus after a refused Save. Nothing is unmounted to hide
 * a section, so an open scenario draft and the unsaved-changes guard survive a filter.
 */

import { act, fireEvent, render, screen, waitFor } from './helpers/test-utils';
import { SettingsModal } from '@/components/app/SettingsModal';
import { ChallengeSettingsModal } from '@/components/app/ChallengeSettingsModal';
import { SettingsSectionPanel } from '@/components/app/SettingsSectionPanel';
import { SETTINGS_NAV_SCROLL_PADDING } from '@/components/app/SettingsNavBar';
import { useSettingsNav } from '@/contexts/SettingsNavContext';
import { mockApi } from './helpers/setup';
import { invalid } from '../helpers/invalid';

const APP_SETTINGS = { theme: 'light', language: 'en', timezone: 'Europe/Riga' };

// Label keys with accents stand in for translated text: an unknown key is shown as it is.
const SCHEMA = {
    exposure: {
        type: 'number',
        default: 70,
        label: 'Ekspozīcija',
        description: 'How much of the challenge to vote on',
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
        description: 'Show the badge row',
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

const sectionOf = (name: string) => screen.getByRole('heading', { level: 4, name }).parentElement as HTMLElement;
const toggleOf = (name: string) =>
    screen.getByRole('heading', { level: 4, name }).querySelector('button') as HTMLElement;
const jumpButton = (name: string) =>
    Array.from(screen.getByRole('group', { name: 'app.settingsJumpLabel' }).querySelectorAll('button')).find(
        (button) => button.textContent === name,
    ) as HTMLElement;
const isOpenSection = (name: string) => sectionOf(name).classList.contains('collapse-open');
const isHidden = (element: Element | null) => (element as HTMLElement).classList.contains('hidden');
const cellOf = (inputId: string) => document.getElementById(inputId)!.closest('.rounded-box') as HTMLElement;
const filterInput = () => screen.getByRole<HTMLInputElement>('searchbox');
const typeFilter = (value: string) => fireEvent.input(filterInput(), { target: { value } });

beforeEach(() => {
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
                { id: 'core', label: 'Core band' },
                { id: 'extra', label: 'Extra band' },
                { id: 'app', label: 'App band' },
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
    window.api.checkScenario = invalid(jest.fn(async () => ({ success: true })));
    window.api.saveScenario = invalid(jest.fn(async () => ({ success: true })));
});

const openSettings = async () => {
    const view = render(<SettingsModal isOpen onClose={onClose} />);
    await screen.findByRole('button', { name: 'app.sbNew' });
    await waitFor(() => expect(document.getElementById('setting-exposure')).not.toBeNull());
    return view;
};

describe('SettingsModal — sections', () => {
    test('Application starts open and the rest closed, each toggle saying so', async () => {
        await openSettings();
        const titles = [
            'app.applicationSettings',
            'app.challengeDefaults',
            'app.titleTagRules',
            'app.scenarios',
            'about.title',
        ];
        expect(titles.map(isOpenSection)).toEqual([true, false, false, false, false]);
        expect(titles.map((title) => sectionOf(title).classList.contains('collapse-close'))).toEqual([
            false,
            true,
            true,
            true,
            true,
        ]);
        const toggle = toggleOf('app.challengeDefaults');
        expect(toggle.getAttribute('aria-expanded')).toBe('false');
        expect(document.getElementById(toggle.getAttribute('aria-controls')!)).not.toBeNull();
        // The tabindex focus variant of the collapse is never used.
        expect(document.querySelector('.collapse[tabindex]')).toBeNull();
    });

    test('clicking a header opens and closes its section, keeping the content mounted', async () => {
        await openSettings();
        const exposure = document.getElementById('setting-exposure');
        fireEvent.click(toggleOf('app.challengeDefaults'));
        expect(isOpenSection('app.challengeDefaults')).toBe(true);
        expect(toggleOf('app.challengeDefaults').getAttribute('aria-expanded')).toBe('true');
        // A hand-opened section keeps the animation.
        expect(sectionOf('app.challengeDefaults').classList.contains('transition-none')).toBe(false);

        fireEvent.click(toggleOf('app.challengeDefaults'));
        expect(isOpenSection('app.challengeDefaults')).toBe(false);
        expect(document.getElementById('setting-exposure')).toBe(exposure);
    });

    test('the modal box keeps focus clear of the sticky bar as well as the footer', async () => {
        await openSettings();
        const box = document.querySelector('.modal-box')!;
        for (const name of SETTINGS_NAV_SCROLL_PADDING.split(' ')) expect(box.classList.contains(name)).toBe(true);
        const bar = filterInput().closest('.sticky')!;
        expect(bar.classList.contains('-top-6')).toBe(true);
        expect(bar.parentElement).toBe(box);
    });

    test('opening the modal again starts from the defaults', async () => {
        const { rerender } = await openSettings();
        fireEvent.click(toggleOf('app.challengeDefaults'));
        typeFilter('turbo');
        rerender(<SettingsModal isOpen={false} onClose={onClose} />);
        rerender(<SettingsModal isOpen onClose={onClose} />);
        await screen.findByRole('button', { name: 'app.sbNew' });
        expect(filterInput().value).toBe('');
        expect(isOpenSection('app.applicationSettings')).toBe(true);
        expect(isOpenSection('app.challengeDefaults')).toBe(false);
    });
});

describe('SettingsModal — jump buttons', () => {
    const scrollIntoView = jest.fn<void, [ScrollIntoViewOptions]>();

    beforeEach(() => {
        scrollIntoView.mockReset();
        window.HTMLElement.prototype.scrollIntoView = scrollIntoView;
    });

    test('a jump opens the section without the animation, scrolls to it and focuses its toggle', async () => {
        await openSettings();
        fireEvent.click(jumpButton('app.challengeDefaults'));

        await waitFor(() => expect(document.activeElement).toBe(toggleOf('app.challengeDefaults')));
        expect(isOpenSection('app.challengeDefaults')).toBe(true);
        expect(scrollIntoView).toHaveBeenCalledWith({ block: 'start', behavior: 'smooth' });
        // The animation is back once the scroll has been issued.
        await waitFor(() =>
            expect(sectionOf('app.challengeDefaults').classList.contains('transition-none')).toBe(false),
        );
    });

    test('a jump to an open section keeps it open', async () => {
        await openSettings();
        fireEvent.click(jumpButton('app.applicationSettings'));
        await waitFor(() => expect(document.activeElement).toBe(toggleOf('app.applicationSettings')));
        expect(isOpenSection('app.applicationSettings')).toBe(true);
    });

    test('the jump row is a single scrollable line', async () => {
        await openSettings();
        const row = screen.getByRole('group', { name: 'app.settingsJumpLabel' });
        expect(row.classList.contains('overflow-x-auto')).toBe(true);
        expect(row.classList.contains('flex-nowrap')).toBe(true);
        expect(row.querySelectorAll('button.btn-xs')).toHaveLength(5);
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

    test('matches a label across accents and hides the cells, groups, bands and sections that do not match', async () => {
        await openSettings();
        typeFilter('ekspozicija');

        expect(isHidden(cellOf('setting-exposure'))).toBe(false);
        expect(isHidden(cellOf('setting-retries'))).toBe(true);
        // Core group still has a match; the extra band has none.
        expect(isHidden(cellOf('setting-exposure').parentElement!.parentElement)).toBe(false);
        expect(isHidden(cellOf('setting-badges').parentElement!.parentElement!.parentElement)).toBe(true);
        // Only Challenge defaults has a match, and the filter opened it.
        expect(isHidden(sectionOf('app.challengeDefaults'))).toBe(false);
        expect(isOpenSection('app.challengeDefaults')).toBe(true);
        for (const title of ['app.applicationSettings', 'app.titleTagRules', 'app.scenarios', 'about.title']) {
            expect(isHidden(sectionOf(title))).toBe(true);
        }
        // Their jump buttons go with them.
        expect(isHidden(jumpButton('app.scenarios'))).toBe(true);
        expect(isHidden(jumpButton('app.challengeDefaults'))).toBe(false);
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
        expect(isHidden(sectionOf('app.applicationSettings'))).toBe(false);
        expect(isHidden(cellOf('ui-timezone'))).toBe(false);
        expect(isHidden(cellOf('ui-theme'))).toBe(true);
        expect(isHidden(sectionOf('app.challengeDefaults'))).toBe(true);

        typeFilter('mission');
        expect(isHidden(cellOf('setting-missionTurbo'))).toBe(false);
        expect(isHidden(cellOf('ui-timezone'))).toBe(true);
        expect(isHidden(sectionOf('app.applicationSettings'))).toBe(false);
    });

    test('the sections without settings match on their heading', async () => {
        await openSettings();
        typeFilter('scenarios');
        expect(isHidden(sectionOf('app.scenarios'))).toBe(false);
        expect(isOpenSection('app.scenarios')).toBe(true);
        expect(isHidden(sectionOf('about.title'))).toBe(true);
        typeFilter('about');
        expect(isHidden(sectionOf('about.title'))).toBe(false);
        typeFilter('titleTag');
        expect(isHidden(sectionOf('app.titleTagRules'))).toBe(false);
    });

    test('clearing the filter brings back what was open before it', async () => {
        await openSettings();
        fireEvent.click(toggleOf('app.scenarios'));
        typeFilter('ekspozicija');
        expect(isOpenSection('app.challengeDefaults')).toBe(true);
        typeFilter('Ekspozicija ');
        typeFilter('');

        expect(isOpenSection('app.applicationSettings')).toBe(true);
        expect(isOpenSection('app.scenarios')).toBe(true);
        expect(isOpenSection('app.challengeDefaults')).toBe(false);
        expect(document.querySelectorAll('.hidden').length).toBe(0);
    });

    test('a blank filter is no filter', async () => {
        await openSettings();
        typeFilter('   ');
        expect(document.querySelectorAll('.collapse.hidden')).toHaveLength(0);
        expect(isOpenSection('app.challengeDefaults')).toBe(false);
    });

    test('with no match anywhere it says so, and Clear brings everything back', async () => {
        await openSettings();
        typeFilter('zzzz');
        expect(screen.getByText('app.settingsNoMatch')).toBeTruthy();
        expect(document.querySelectorAll('.collapse:not(.hidden)')).toHaveLength(0);

        fireEvent.click(screen.getByRole('button', { name: 'app.settingsFilterClear' }));
        expect(screen.queryByText('app.settingsNoMatch')).toBeNull();
        expect(filterInput().value).toBe('');
        expect(isOpenSection('app.applicationSettings')).toBe(true);
    });

    test('staged values of hidden settings are still saved', async () => {
        await openSettings();
        fireEvent.change(document.getElementById('setting-exposure')!, { target: { value: '80' } });
        typeFilter('turbo');
        expect(isHidden(cellOf('setting-exposure'))).toBe(true);

        fireEvent.click(screen.getByRole('button', { name: 'app.save' }));
        await waitFor(() => expect(mockApi.setGlobalDefault).toHaveBeenCalledWith('exposure', 80));
    });
});

describe('SettingsModal — a draft survives hiding its section', () => {
    const editScenario = async () => {
        fireEvent.click(screen.getByRole('button', { name: 'app.sbNew' }));
        await screen.findByLabelText('app.sbName');
        fireEvent.change(screen.getByLabelText('app.sbName'), { target: { value: 'Draft' } });
    };

    test('a non-matching filter and closing the section keep the draft, and Save still prompts', async () => {
        await openSettings();
        fireEvent.click(toggleOf('app.scenarios'));
        await editScenario();
        const field = screen.getByLabelText<HTMLInputElement>('app.sbName');

        typeFilter('zzzz');
        expect(isHidden(sectionOf('app.scenarios'))).toBe(true);
        typeFilter('');
        fireEvent.click(toggleOf('app.scenarios'));
        expect(isOpenSection('app.scenarios')).toBe(false);

        expect(screen.getByLabelText<HTMLInputElement>('app.sbName')).toBe(field);
        expect(field.value).toBe('Draft');
        fireEvent.click(screen.getByRole('button', { name: 'app.save' }));
        expect(screen.getByText('app.settingsDropScenario')).toBeTruthy();
        expect(mockApi.setGlobalDefault).not.toHaveBeenCalled();
    });
});

describe('SettingsModal — focus after a refused Save', () => {
    const refuseExposure = async () => {
        mockApi.setGlobalDefault.mockResolvedValue(false);
        await openSettings();
        fireEvent.change(document.getElementById('setting-exposure')!, { target: { value: '80' } });
    };
    const save = () => fireEvent.click(screen.getByRole('button', { name: 'app.save' }));

    test('a key in a closed section clears the filter, opens the section and takes focus', async () => {
        await refuseExposure();
        typeFilter('zzzz');
        expect(isOpenSection('app.challengeDefaults')).toBe(false);

        save();
        await screen.findByText('app.settingsSaveError');
        const input = document.getElementById('setting-exposure')!;
        await waitFor(() => expect(document.activeElement).toBe(input));
        expect(filterInput().value).toBe('');
        expect(isOpenSection('app.challengeDefaults')).toBe(true);
        expect(isOpenSection('app.applicationSettings')).toBe(true);
        expect(input.getAttribute('aria-invalid')).toBe('true');
        // The open animation is back once the focus has landed.
        await waitFor(() =>
            expect(sectionOf('app.challengeDefaults').classList.contains('transition-none')).toBe(false),
        );
    });

    test('a refused theme opens the Application section it sits in', async () => {
        mockApi.setSetting.mockResolvedValue(false);
        await openSettings();
        fireEvent.click(toggleOf('app.applicationSettings'));
        expect(isOpenSection('app.applicationSettings')).toBe(false);
        act(() => {
            const theme = document.getElementById('ui-theme') as HTMLSelectElement;
            theme.value = 'dark';
            theme.dispatchEvent(new window.Event('change', { bubbles: true }));
        });

        save();
        await screen.findByText('app.settingsSaveError');
        await waitFor(() => expect(document.activeElement).toBe(document.getElementById('ui-theme')));
        expect(isOpenSection('app.applicationSettings')).toBe(true);
    });

    test('a refused app-tier schema key opens Application', async () => {
        mockApi.setGlobalDefault.mockResolvedValue(false);
        mockApi.setSetting.mockResolvedValue(false);
        await openSettings();
        fireEvent.click(toggleOf('app.applicationSettings'));
        fireEvent.click(document.getElementById('setting-missionTurbo')!);

        save();
        await screen.findByText('app.settingsSaveError');
        await waitFor(() => expect(document.activeElement).toBe(document.getElementById('setting-missionTurbo')));
        expect(isOpenSection('app.applicationSettings')).toBe(true);
    });

    test('refused title rules open their section and focus its heading', async () => {
        mockApi.setTitleRules.mockResolvedValue(false);
        await openSettings();
        fireEvent.click(screen.getByRole('button', { name: 'app.addTitleTagRule' }));
        typeFilter('zzzz');

        save();
        await screen.findByText('app.titleTagRulesSaveError');
        const heading = screen.getByRole('heading', { level: 4, name: 'app.titleTagRules' });
        await waitFor(() => expect(document.activeElement).toBe(heading));
        expect(isOpenSection('app.titleTagRules')).toBe(true);
        expect(filterInput().value).toBe('');
    });

    test('a refused language save opens Application and focuses its heading', async () => {
        mockApi.setSetting.mockResolvedValue(false);
        await openSettings();
        fireEvent.click(toggleOf('app.applicationSettings'));
        act(() => {
            const language = document.getElementById('ui-language') as HTMLSelectElement;
            language.value = 'lv';
            language.dispatchEvent(new window.Event('change', { bubbles: true }));
        });

        save();
        await screen.findByText('app.settingsSaveError');
        const heading = screen.getByRole('heading', { level: 4, name: 'app.applicationSettings' });
        await waitFor(() => expect(document.activeElement).toBe(heading));
        expect(isOpenSection('app.applicationSettings')).toBe(true);
    });
});

describe('the default navigation (outside the settings modal)', () => {
    test('shows everything open and unfiltered', () => {
        function Probe() {
            const nav = useSettingsNav();
            nav.toggle('about');
            nav.setQuery('x');
            nav.jumpTo('about');
            nav.reveal('about');
            nav.settle();
            nav.reset();
            return <p>{`${nav.query}|${nav.open.about}|${nav.shown.about}|${nav.instant}`}</p>;
        }
        render(<Probe />);
        expect(screen.getByText('|true|true|null')).toBeTruthy();
    });

    test('a section panel outside the modal renders open and visible', () => {
        render(
            <SettingsSectionPanel id="about">
                <p>inside</p>
            </SettingsSectionPanel>,
        );
        const panel = screen.getByRole('heading', { level: 4 }).parentElement!;
        expect(panel.classList.contains('collapse-open')).toBe(true);
        expect(panel.classList.contains('hidden')).toBe(false);
        fireEvent.click(screen.getByRole('button', { name: 'about.title' }));
        expect(panel.classList.contains('collapse-open')).toBe(true);
    });

    test('the per-challenge modal, which shares the cells, has no sections and nothing hidden', async () => {
        render(<ChallengeSettingsModal isOpen onClose={onClose} challengeId="1" challengeTitle="One" />);
        await waitFor(() => expect(document.getElementById('challenge-setting-exposure')).not.toBeNull());
        expect(document.querySelector('.collapse')).toBeNull();
        expect(document.querySelector('input[type="search"]')).toBeNull();
        expect(document.querySelector('.modal-box .hidden')).toBeNull();
    });
});
