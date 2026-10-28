import { useMemo, useRef } from 'react';
import { useTranslation } from '@/contexts/TranslationContext';
import { settingsPanelId, settingsTabId, useSettingsNav } from '@/contexts/SettingsNavContext';
import { useScrollPanelIntoView } from '@/hooks/useScrollPanelIntoView';
import { TabList } from '@/components/ui/Tabs';

import type { TabDescriptor } from '@/components/ui/Tabs';
import type { SettingsTabId } from '@/utils/groupSettings';

// The modal box's scroll padding for the bar pinned at the top of the settings body, next to
// STICKY_FOOTER_SCROLL_PADDING: a focused tab, a Tab focus or a Save-failure focus must not land
// under it. On a phone the bar is one tab row with the filter stacked under it (40 px row + 8 px
// gap + 32 px input + py-2 + border, about 6rem); from `sm` to `xl` the row wraps to two lines
// with the filter still stacked (about 8.5rem); from `xl` it is one row beside the filter again
// (40 px row + py-2 + border, about 3.5rem). Each step includes room for the focus ring.
export const SETTINGS_NAV_SCROLL_PADDING = 'scroll-pt-28 sm:scroll-pt-36 xl:scroll-pt-16';

/**
 * The bar pinned at the top of the settings modal's body: the section tabs in one scrollable
 * row, and the filter field. It takes the footer's treatment: opaque, flush with the box edges.
 * The tab descriptors (labels applied, filter and refused-Save marks included) come from the
 * modal, which owns both the schema and the rejected keys.
 */
export function SettingsNavBar({ tabs }: { tabs: ReadonlyArray<TabDescriptor<SettingsTabId>> }) {
    const { t } = useTranslation();
    const nav = useSettingsNav();
    const barRef = useRef<HTMLDivElement>(null);
    // useScrollPanelIntoView scrolls the modal box, which Modal renders around this bar (the
    // bar is a direct child of it), so the box is reached from the bar at scroll time —
    // Modal's own ref is not ours to take. The bar itself is the hook's sticky ref: its height
    // is measured at scroll time, so the clearance is right at every breakpoint. The hook
    // reads these only from its layout effect, which cannot run while the bar is unmounted
    // and mounts after the ref has attached, so the ref is always set here.
    const bodyRef = useMemo<{ readonly current: HTMLElement | null }>(
        () => ({
            get current() {
                return barRef.current!.parentElement;
            },
        }),
        [],
    );
    const requestScroll = useScrollPanelIntoView(bodyRef, barRef);

    // A user selection scrolls the panel back into view (after selecting, once it renders);
    // clicking the already-active tab neither re-selects nor requests a scroll.
    const onSelect = (id: SettingsTabId) => {
        if (id === nav.active) return;
        nav.select(id);
        requestScroll(settingsPanelId(id));
    };

    // The filter stacks under the tab row below `xl`. Between `sm` and `xl` the row also wraps:
    // seven labels beside a same-row filter side-scroll off the row with no cue on
    // overlay-scrollbar platforms, so the row wraps there and is one scrolling line again —
    // beside the filter — from `xl` up.
    return (
        <div
            ref={barRef}
            className="sticky -top-6 z-10 -mx-6 mb-4 px-6 py-2 bg-base-100 border-b border-base-300 flex flex-col gap-2 xl:flex-row xl:items-center"
        >
            <div className="min-w-0 xl:flex-1">
                <TabList
                    label={t('app.settingsJumpLabel')}
                    rowClassName="sm:flex-wrap sm:overflow-x-visible xl:flex-nowrap xl:overflow-x-auto"
                    tabs={tabs}
                    active={nav.active}
                    onSelect={onSelect}
                    selectionSeq={nav.selectionSeq}
                    tabId={settingsTabId}
                    panelId={settingsPanelId}
                />
            </div>
            <input
                type="search"
                className="input input-sm w-full xl:w-56"
                placeholder={t('app.settingsFilterPlaceholder')}
                aria-label={t('app.settingsFilterPlaceholder')}
                autoComplete="off"
                spellcheck={false}
                value={nav.query}
                onChange={(e) => nav.setQuery(e.currentTarget.value)}
                onKeyDown={(e) => {
                    // Escape clears a filter that has text; the modal closes only when there is nothing to clear.
                    if (e.key === 'Escape' && nav.query !== '') {
                        e.stopPropagation();
                        nav.setQuery('');
                    }
                }}
            />
        </div>
    );
}

/**
 * What the modal shows when the filter matches nothing in any section.
 */
export function SettingsNoMatch() {
    const { t } = useTranslation();
    const nav = useSettingsNav();
    return (
        <div className="flex flex-wrap items-center gap-3 text-sm">
            <span role="status">{t('app.settingsNoMatch')}</span>
            <button type="button" className="btn btn-sm" onClick={() => nav.setQuery('')}>
                {t('app.settingsFilterClear')}
            </button>
        </div>
    );
}
