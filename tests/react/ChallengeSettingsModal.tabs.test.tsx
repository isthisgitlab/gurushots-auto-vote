/**
 * ChallengeSettingsModal tabs: one tab per tier band. The tab row only shows
 * for two or more bands (a single band keeps its visible heading), an edit
 * survives a switch, each tab counts its band's overrides (a key whose group
 * maps to no band counts in the summary and on no tab), with Manual Only on
 * the banner keeps the sticky slot so the row scrolls with the content
 * instead of sticking, and a user selection scrolls the panel below the
 * sticky chrome — again after a reopen, and never from a Manual Only toggle.
 */
import { fireEvent, render, screen, waitFor } from './helpers/test-utils';
import { ChallengeSettingsModal } from '@/components/app/ChallengeSettingsModal';
import { selectTab } from '../helpers/selectTab';
import { defaultTranslate, mockApi, mockTranslator } from './helpers/setup';
import type { useSettingsSchema } from '@/api/useSettingsSchema';
import { invalid } from '../helpers/invalid';

const field = (group: string, type: string, dflt: unknown, label: string) => ({
    type,
    default: dflt,
    perChallenge: true,
    group,
    label,
    description: 'app.desc',
});

// Three tiers, one group each: boost in core, autoJoin in entries, the
// scheduled-fill toggle in overrides.
const BASE_SCHEMA = {
    boostTime: field('boost', 'number', 30, 'app.boostTime'),
    autoJoin: field('autoSubmit', 'boolean', false, 'app.autoJoin'),
    useScheduledFill: field('scheduledFill', 'boolean', false, 'app.useScheduledFill'),
};

const mockSchemaState: Partial<ReturnType<typeof useSettingsSchema>> = {
    schema: invalid(BASE_SCHEMA),
    defaults: { boostTime: 30, autoJoin: false, useScheduledFill: false },
    groups: [
        { id: 'boost', label: 'app.groupBoost', tier: 'core' },
        { id: 'autoSubmit', label: 'app.groupAutoSubmit', tier: 'entries' },
        { id: 'scheduledFill', label: 'app.groupScheduledFill', tier: 'overrides' },
    ],
    tiers: [
        { id: 'core', label: 'app.tierCore' },
        { id: 'entries', label: 'app.tierEntries' },
        { id: 'overrides', label: 'app.tierOverrides' },
    ],
    profileLimits: null,
    refetch: jest.fn(),
    loading: false,
};

jest.mock('@/api/useSettingsSchema', () => ({
    useSettingsSchema: () => mockSchemaState,
}));

const pristine = { ...mockSchemaState };

beforeEach(() => {
    window.api = invalid(mockApi);
    mockApi.getTitleProfile.mockReset().mockResolvedValue(null);
    mockApi.getChallengeOverrides.mockReset().mockResolvedValue({});
    window.HTMLElement.prototype.scrollIntoView = jest.fn();
});

afterEach(() => {
    Object.assign(mockSchemaState, pristine);
    mockTranslator.t.mockImplementation(defaultTranslate);
    jest.restoreAllMocks();
});

const renderModal = (props = {}) => {
    const onClose = jest.fn();
    const utils = render(
        <ChallengeSettingsModal
            isOpen={true}
            onClose={onClose}
            challengeId="1"
            challengeTitle="Challenge 1"
            {...props}
        />,
    );
    return { ...utils, onClose };
};

const loaded = () => waitFor(() => expect(screen.getByRole('tab', { name: /^app\.tierCore/ })).toBeTruthy());
const tablist = () => screen.getByRole('tablist', { name: 'app.settingsJumpLabel' });
const row = () => tablist().parentElement!;

// The panel-scroll stubs, with the hook test's figures (useScrollPanelIntoView.test.tsx):
// the box's visible top is 100, a panel top 60; happy-dom measures zero rects and zero
// offsetHeight, so both are defined by hand.
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
const stubScrollRects = () => {
    jest.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
        return rect(this.id.startsWith('challenge-settings-panel-') ? 60 : 100);
    });
};
/** The sticky chrome measures 48: with the body at scrollTop 200, a selection lands at 112. */
const stubStickyHeight = () => {
    Object.defineProperty(row(), 'offsetHeight', { value: 48, configurable: true });
};

describe('ChallengeSettingsModal tabs', () => {
    test('each band is a tab, and a fresh open shows the first band', async () => {
        renderModal();
        await loaded();

        expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
            'app.tierCore',
            'app.tierEntries',
            'app.tierOverrides',
        ]);
        // This modal's own id prefix, so the global modal's tabs cannot collide with these.
        expect(screen.getByRole('tab', { name: 'app.tierCore' }).id).toBe('challenge-settings-tab-tier-core');
        expect(screen.getByRole('tab', { name: 'app.tierCore' }).getAttribute('aria-controls')).toBe(
            'challenge-settings-panel-tier-core',
        );
        expect(screen.getByRole('tab', { name: 'app.tierCore' }).getAttribute('aria-selected')).toBe('true');
        expect(screen.getByRole('tab', { name: 'app.tierEntries' }).getAttribute('aria-selected')).toBe('false');

        // Every panel stays mounted; only the first band's is visible. The modal portals to the
        // body, so the panels are found there, not in the test's container.
        expect(screen.getAllByRole('tabpanel')).toHaveLength(1);
        for (const band of ['entries', 'overrides']) {
            const panel = document.getElementById(`challenge-settings-panel-tier-${band}`)!;
            expect(document.body.contains(panel)).toBe(true);
            expect(panel.hasAttribute('hidden')).toBe(true);
        }
    });

    test('an edit survives a switch to another band and back', async () => {
        renderModal();
        await loaded();

        const input = document.querySelector<HTMLInputElement>('#challenge-setting-boostTime')!;
        fireEvent.input(input, { target: { value: '12' } });
        fireEvent.blur(input);
        await waitFor(() => expect(screen.getAllByText('app.overridden').length).toBeGreaterThan(0));

        selectTab('app.tierEntries');
        expect(document.getElementById('challenge-settings-panel-tier-entries')!.hasAttribute('hidden')).toBe(false);

        // The edit gave the core tab an override badge, part of its accessible name.
        selectTab(/app\.tierCore/);
        expect(document.querySelector<HTMLInputElement>('#challenge-setting-boostTime')!.value).toBe('12');
        expect(screen.getAllByText('app.overridden').length).toBeGreaterThan(0);
    });

    test("each tab counts its band's overrides with their sr-only meaning; a band with none shows no badge", async () => {
        mockApi.getChallengeOverrides.mockResolvedValue({ boostTime: 5, autoJoin: true });
        renderModal();
        await loaded();

        // The visible badge count and the sr-only text in the accessible name (the mock
        // translator echoes keys, as everywhere).
        const core = screen.getByRole('tab', { name: 'app.tierCore app.tabOverrideCount' });
        expect(core.querySelector('.badge')!.textContent).toBe('1');
        const entries = screen.getByRole('tab', { name: 'app.tierEntries app.tabOverrideCount' });
        expect(entries.querySelector('.badge')!.textContent).toBe('1');
        // The overrides band holds none of the set keys: no badge, plain accessible name.
        const overrides = screen.getByRole('tab', { name: 'app.tierOverrides' });
        expect(overrides.querySelector('.badge')).toBeNull();
    });

    test('with no overrides set, no tab shows a badge', async () => {
        renderModal();
        await loaded();
        for (const tab of screen.getAllByRole('tab')) {
            expect(tab.querySelector('.badge')).toBeNull();
        }
    });

    test('a stored key whose group maps to no band counts in the summary and on no tab', async () => {
        // The intentional asymmetry: the summary counts every stored key, a tab badge only keys
        // whose schema group lies in a per-challenge band. A stale stored key the schema still
        // allows (its group was renamed away) shows in the total and on no tab — so the badges
        // can sum to one less than the total.
        mockSchemaState.schema = invalid({
            ...BASE_SCHEMA,
            staleKey: field('vanished', 'number', 0, 'app.staleKey'),
        });
        mockApi.getChallengeOverrides.mockResolvedValue({ boostTime: 5, staleKey: 1 });
        // The echoing translator hides an interpolated count; surface it for the summary key.
        mockTranslator.t.mockImplementation((key: string) =>
            key === 'app.overridesActiveSummary' ? '{0} overrides' : key,
        );
        renderModal();
        await waitFor(() => expect(document.querySelector('p[role="status"]')!.textContent).toBe('2 overrides'));

        // The banded key counts on its tab; the unbanded one on none — the badges sum to N−1.
        const core = screen.getByRole('tab', { name: 'app.tierCore app.tabOverrideCount' });
        expect(core.querySelector('.badge')!.textContent).toBe('1');
        for (const name of ['app.tierEntries', 'app.tierOverrides']) {
            expect(screen.getByRole('tab', { name }).querySelector('.badge')).toBeNull();
        }
    });

    test('the visible panel is named by an sr-only band heading, and the overrides band carries its intro line', async () => {
        renderModal();
        await loaded();

        expect(screen.getByRole('heading', { level: 4, name: 'app.tierCore' })).toBeTruthy();
        expect(document.getElementById('challenge-settings-panel-tier-core')!.textContent).not.toContain(
            'app.tierOverridesDesc',
        );

        selectTab('app.tierOverrides');
        expect(screen.getByRole('heading', { level: 4, name: 'app.tierOverrides' })).toBeTruthy();
        expect(document.getElementById('challenge-settings-panel-tier-overrides')!.textContent).toContain(
            'app.tierOverridesDesc',
        );
    });

    test('the tab row sticks to the top of the scroll area, and the box pads for it (Manual Only off)', async () => {
        renderModal();
        await loaded();

        // The global modal's bar treatment: opaque, flush with the box edges.
        for (const cls of ['sticky', '-top-6', 'z-10', '-mx-6', 'px-6', 'bg-base-100']) {
            expect(row().classList.contains(cls)).toBe(true);
        }
        // happy-dom lays nothing out, so the padding that keeps a focused control below the row is
        // a class check, alongside the footer's and the steady box height.
        const box = document.querySelector('.modal-box')!.classList;
        expect(box.contains('scroll-pt-12')).toBe(true);
        expect(box.contains('scroll-pb-60')).toBe(true);
        expect(box.contains('h-[calc(100vh-5em)]')).toBe(true);
        expect(box.contains('flex-col')).toBe(true);
    });

    test('the steady box belongs to the form: the first-load spinner keeps the plain box', () => {
        mockSchemaState.loading = true;
        mockSchemaState.schema = null;
        renderModal();
        expect(screen.getByRole('status').textContent).toBe('common.loading');

        const box = document.querySelector('.modal-box')!.classList;
        expect(box.contains('h-[calc(100vh-5em)]')).toBe(false);
        expect(box.contains('flex-col')).toBe(false);
    });

    test('clicking the already-active tab neither re-selects nor asks for a scroll', async () => {
        renderModal();
        await loaded();
        const scrollIntoView = window.HTMLElement.prototype.scrollIntoView as jest.MockedFunction<
            typeof HTMLElement.prototype.scrollIntoView
        >;

        fireEvent.click(screen.getByRole('tab', { name: 'app.tierCore' }));
        expect(scrollIntoView).not.toHaveBeenCalled();
        expect(screen.getByRole('tab', { name: 'app.tierCore' }).getAttribute('aria-selected')).toBe('true');

        // A real selection still scrolls the row.
        selectTab('app.tierEntries');
        expect(scrollIntoView).toHaveBeenCalledWith({ inline: 'nearest', block: 'nearest' });
    });

    test('reopening starts at the first band again', async () => {
        const { rerender } = renderModal();
        await loaded();
        selectTab('app.tierOverrides');
        expect(screen.getByRole('tab', { name: 'app.tierOverrides' }).getAttribute('aria-selected')).toBe('true');

        rerender(<ChallengeSettingsModal isOpen={false} onClose={jest.fn()} challengeId="1" challengeTitle="C" />);
        rerender(<ChallengeSettingsModal isOpen={true} onClose={jest.fn()} challengeId="1" challengeTitle="C" />);
        await loaded();
        expect(screen.getByRole('tab', { name: 'app.tierCore' }).getAttribute('aria-selected')).toBe('true');
    });

    test('reopening and re-selecting the same band scrolls again (requests are one-shot, not deduped)', async () => {
        // The modal stays mounted while closed, so a reopen is the same hook asking for the same
        // panel id a second time — the flow a per-id dedupe swallowed and the one-shot hook runs.
        const box = () => document.querySelector('.modal-box')!;
        const { rerender } = renderModal();
        await loaded();
        stubScrollRects();
        stubStickyHeight();
        box().scrollTop = 200;
        selectTab('app.tierEntries');
        // target = 60 - 100 + 200 - 48
        expect(box().scrollTop).toBe(112);

        rerender(
            <ChallengeSettingsModal isOpen={false} onClose={jest.fn()} challengeId="1" challengeTitle="Challenge 1" />,
        );
        rerender(
            <ChallengeSettingsModal isOpen={true} onClose={jest.fn()} challengeId="1" challengeTitle="Challenge 1" />,
        );
        await loaded();
        stubStickyHeight(); // the reopen rebuilt the DOM; the fresh row measures again

        box().scrollTop = 200;
        selectTab('app.tierEntries');
        expect(box().scrollTop).toBe(112);
    });

    test('toggling Manual Only after a consumed scroll request does not scroll the body', async () => {
        mockSchemaState.schema = invalid({
            ...BASE_SCHEMA,
            manualPhotosOnly: field('boost', 'boolean', false, 'app.manualPhotosOnly'),
        });
        const box = () => document.querySelector('.modal-box')!;
        renderModal();
        await loaded();
        stubScrollRects();
        stubStickyHeight();
        box().scrollTop = 200;
        selectTab('app.tierEntries');
        expect(box().scrollTop).toBe(112);

        // The toggle swaps the sticky chrome (banner in, row unsticky) but is no tab selection:
        // the hook is never asked again, so the consumed request stays consumed.
        fireEvent.click(document.querySelector<HTMLInputElement>('#challenge-setting-manualPhotosOnly')!);
        expect(screen.getByText(/app\.manualOnlyLabel/)).toBeTruthy();
        expect(row().classList.contains('sticky')).toBe(false);
        expect(box().scrollTop).toBe(112);
    });

    describe('with Manual Only on', () => {
        test('the tabs still work, and the row scrolls with the content instead of sticking', async () => {
            mockSchemaState.schema = invalid({
                ...BASE_SCHEMA,
                manualPhotosOnly: field('boost', 'boolean', false, 'app.manualPhotosOnly'),
            });
            mockApi.getChallengeOverrides.mockResolvedValue({ manualPhotosOnly: true });
            renderModal();
            await loaded();

            expect(tablist()).toBeTruthy();
            selectTab('app.tierEntries');
            expect(screen.getByRole('tab', { name: 'app.tierEntries' }).getAttribute('aria-selected')).toBe('true');
            // The banner keeps the sticky slot (a second sticky row would stack two offsets that
            // depend on the banner's wrapping height): the row loses its sticky classes only.
            expect(row().classList.contains('sticky')).toBe(false);
            expect(row().classList.contains('-mx-6')).toBe(true);
            expect(row().classList.contains('bg-base-100')).toBe(true);
        });
    });

    test('with a single band there is no tablist, and the band keeps its visible heading', async () => {
        mockSchemaState.schema = invalid({ boostTime: BASE_SCHEMA.boostTime });
        mockSchemaState.defaults = { boostTime: 30 };
        mockSchemaState.groups = [{ id: 'boost', label: 'app.groupBoost', tier: 'core' }];
        mockSchemaState.tiers = [{ id: 'core', label: 'app.tierCore' }];
        renderModal();

        await waitFor(() => expect(document.querySelector('#challenge-setting-boostTime')).toBeTruthy());
        expect(screen.queryByRole('tablist')).toBeNull();
        const heading = screen.getByRole('heading', { level: 4, name: 'app.tierCore' });
        expect(heading.classList.contains('sr-only')).toBe(false);
        expect(screen.getByRole('heading', { level: 5, name: 'app.groupBoost' })).toBeTruthy();
    });
});
