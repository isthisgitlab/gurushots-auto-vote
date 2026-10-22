/**
 * Tabs — the WAI-ARIA tab row and panels the settings modals navigate with:
 * ARIA wiring, keyboard wrapping over visible tabs, the error/override
 * markers in the accessible name, and the selection-driven scroll-into-view.
 */
import { useState } from 'react';
import { fireEvent, render, screen } from './helpers/test-utils';
import { TabList, TabPanel } from '@/components/ui/Tabs';

import type { TabDescriptor } from '@/components/ui/Tabs';

type TabId = 'a' | 'b' | 'c' | 'd';

const tabId = (id: string) => `tab-${id}`;
const panelId = (id: string) => `panel-${id}`;

const named = (label: string): TabDescriptor<TabId> => ({ id: label.toLowerCase() as TabId, label });

/**
 * The wiring the settings modals build on: a user selection bumps the
 * selection counter, while the `derive-active` button stands in for a
 * refetch-derived `active` change that must not count as a selection.
 */
function TabsHarness({ tabs }: { tabs: TabDescriptor<TabId>[] }) {
    const [active, setActive] = useState<TabId>('a');
    const [seq, setSeq] = useState(0);
    return (
        <>
            <TabList
                label="app.settingsJumpLabel"
                tabs={tabs}
                active={active}
                selectionSeq={seq}
                onSelect={(id) => {
                    setActive(id);
                    setSeq((n) => n + 1);
                }}
                tabId={tabId}
                panelId={panelId}
            />
            {tabs.map((tab) => (
                <TabPanel
                    key={tab.id}
                    id={tab.id}
                    tabId={tabId}
                    panelId={panelId}
                    active={active === tab.id}
                    title={tab.label}
                >
                    {`panel ${tab.id} body`}
                </TabPanel>
            ))}
            <button type="button" onClick={() => setActive('b')}>
                derive-active
            </button>
        </>
    );
}

describe('TabList ARIA wiring', () => {
    test('the row is a labelled, single-line scrollable tablist; tabs carry ids and selection state', () => {
        render(<TabsHarness tabs={[named('A'), named('B'), named('C')]} />);

        const row = screen.getByRole('tablist', { name: 'app.settingsJumpLabel' });
        expect(row.classList.contains('tabs')).toBe(true);
        expect(row.classList.contains('tabs-border')).toBe(true);
        expect(row.classList.contains('flex-nowrap')).toBe(true);
        expect(row.classList.contains('overflow-x-auto')).toBe(true);

        const a = screen.getByRole('tab', { name: 'A' });
        expect(a.id).toBe('tab-a');
        expect(a.getAttribute('aria-controls')).toBe('panel-a');
        expect(a.getAttribute('aria-selected')).toBe('true');
        expect(a.getAttribute('tabindex')).toBe('0');
        expect(a.classList.contains('shrink-0')).toBe(true);

        const b = screen.getByRole('tab', { name: 'B' });
        expect(b.getAttribute('aria-selected')).toBe('false');
        expect(b.getAttribute('tabindex')).toBe('-1');
    });

    test('every panel stays mounted; the active one is shown and labelled by its tab', () => {
        const { container } = render(<TabsHarness tabs={[named('A'), named('B'), named('C')]} />);

        expect(screen.getByText('panel a body')).toBeTruthy();
        expect(screen.getByText('panel b body')).toBeTruthy();
        expect(screen.getByText('panel c body')).toBeTruthy();

        const visible = screen.getAllByRole('tabpanel');
        expect(visible).toHaveLength(1);
        expect(visible[0].id).toBe('panel-a');
        expect(visible[0].hasAttribute('hidden')).toBe(false);
        expect(visible[0].getAttribute('aria-labelledby')).toBe('tab-a');

        for (const id of ['b', 'c']) {
            const hidden = document.getElementById(`panel-${id}`)!;
            expect(container.contains(hidden)).toBe(true);
            expect(hidden.hasAttribute('hidden')).toBe(true);
            expect(hidden.getAttribute('aria-labelledby')).toBe(`tab-${id}`);
        }
    });

    test('each panel opens with an sr-only h4 naming it', () => {
        render(<TabsHarness tabs={[named('A'), named('B')]} />);
        const heading = document.getElementById('panel-a')!.querySelector('h4');
        expect(heading?.textContent).toBe('A');
    });
});

describe('TabList selection', () => {
    test('selecting a tab moves the selection, the roving tabindex and the panels', () => {
        render(<TabsHarness tabs={[named('A'), named('B'), named('C')]} />);

        fireEvent.click(screen.getByRole('tab', { name: 'B' }));

        expect(screen.getByRole('tab', { name: 'B' }).getAttribute('aria-selected')).toBe('true');
        expect(screen.getByRole('tab', { name: 'B' }).getAttribute('tabindex')).toBe('0');
        expect(screen.getByRole('tab', { name: 'A' }).getAttribute('tabindex')).toBe('-1');
        expect(document.getElementById('panel-b')!.hasAttribute('hidden')).toBe(false);
        expect(document.getElementById('panel-a')!.hasAttribute('hidden')).toBe(true);
    });
});

describe('TabList keyboard', () => {
    test('arrows wrap over the visible tabs only, skipping a hidden one, and move focus', () => {
        render(<TabsHarness tabs={[named('A'), { ...named('B'), hidden: true }, named('C')]} />);

        const a = screen.getByRole('tab', { name: 'A' });
        fireEvent.keyDown(a, { key: 'ArrowRight' });

        // Visible order is A, C — B is mounted but hidden and never takes the selection.
        expect(screen.getByRole('tab', { name: 'C' }).getAttribute('aria-selected')).toBe('true');
        expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'C' }));

        fireEvent.keyDown(screen.getByRole('tab', { name: 'C' }), { key: 'ArrowRight' });
        expect(screen.getByRole('tab', { name: 'A' }).getAttribute('aria-selected')).toBe('true');

        fireEvent.keyDown(screen.getByRole('tab', { name: 'A' }), { key: 'ArrowLeft' });
        expect(screen.getByRole('tab', { name: 'C' }).getAttribute('aria-selected')).toBe('true');
    });

    test('Home and End go to the first and last visible tab, with the end tab hidden', () => {
        render(<TabsHarness tabs={[named('A'), named('B'), { ...named('C'), hidden: true }]} />);

        fireEvent.keyDown(screen.getByRole('tab', { name: 'B' }), { key: 'Home' });
        expect(screen.getByRole('tab', { name: 'A' }).getAttribute('aria-selected')).toBe('true');

        fireEvent.keyDown(screen.getByRole('tab', { name: 'A' }), { key: 'End' });
        expect(screen.getByRole('tab', { name: 'B' }).getAttribute('aria-selected')).toBe('true');
        expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'B' }));
    });

    test('an unhandled key leaves the selection and focus where they are', () => {
        render(<TabsHarness tabs={[named('A'), named('B'), named('C')]} />);

        const a = screen.getByRole('tab', { name: 'A' });
        a.focus();
        fireEvent.keyDown(a, { key: 'x' });

        expect(screen.getByRole('tab', { name: 'A' }).getAttribute('aria-selected')).toBe('true');
        expect(screen.getByRole('tab', { name: 'B' }).getAttribute('aria-selected')).toBe('false');
        expect(document.activeElement).toBe(a);
    });
});

describe('TabList markers', () => {
    test('an invalid tab says so in its accessible name, next to a decorative dot', () => {
        render(<TabsHarness tabs={[named('A'), { ...named('B'), invalid: true }]} />);

        // The mock translator echoes keys, so the sr-only text surfaces as the key.
        const b = screen.getByRole('tab', { name: 'B app.tabHasErrors' });
        expect(b.querySelector('.badge-error')).toBeTruthy();
    });

    test('a badge count is in the accessible name with its meaning, and hidden from sighted duplicates', () => {
        render(<TabsHarness tabs={[named('A'), { ...named('B'), badge: 3 }]} />);

        const b = screen.getByRole('tab', { name: 'B app.tabOverrideCount' });
        const count = b.querySelector('.badge')!;
        expect(count.textContent).toBe('3');
        expect(count.getAttribute('aria-hidden')).toBe('true');
    });

    test('zero shows no badge', () => {
        render(<TabsHarness tabs={[named('A'), { ...named('B'), badge: 0 }]} />);

        expect(screen.getByRole('tab', { name: 'B' })).toBeTruthy();
        expect(screen.getByRole('tab', { name: 'B' }).querySelector('.badge')).toBeNull();
    });
});

describe('TabList scroll-into-view', () => {
    const scrollIntoView = jest.fn<void, [ScrollIntoViewOptions]>();

    beforeEach(() => {
        scrollIntoView.mockReset();
        window.HTMLElement.prototype.scrollIntoView = scrollIntoView;
    });

    test('a user selection scrolls the active tab into the row', () => {
        render(<TabsHarness tabs={[named('A'), named('B'), named('C')]} />);
        scrollIntoView.mockClear();

        fireEvent.click(screen.getByRole('tab', { name: 'C' }));

        expect(scrollIntoView).toHaveBeenCalledWith({ inline: 'nearest', block: 'nearest' });
        expect(scrollIntoView.mock.instances.at(-1)).toBe(screen.getByRole('tab', { name: 'C' }));
    });

    test('a derived active change does not scroll the row', () => {
        render(<TabsHarness tabs={[named('A'), named('B'), named('C')]} />);
        scrollIntoView.mockClear();

        fireEvent.click(screen.getByText('derive-active'));

        // The harness really did move the selection — without counting it as a user selection.
        expect(screen.getByRole('tab', { name: 'B' }).getAttribute('aria-selected')).toBe('true');
        expect(scrollIntoView).not.toHaveBeenCalled();
    });
});
