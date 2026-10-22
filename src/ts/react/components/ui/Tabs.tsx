import { useEffect, useRef } from 'react';
import { useTranslation } from '@/contexts/TranslationContext';

import type { ComponentChildren, TargetedKeyboardEvent } from 'preact';

/**
 * One tab in a TabList. `label` is the display-ready text the caller has
 * already translated; `hidden` (a filter hid the section) leaves the tab
 * mounted but takes it out of the row, the keyboard order and the queries;
 * `invalid` marks a section with problems; `badge` shows a count (overrides)
 * with its meaning spelled out to screen readers.
 */
export interface TabDescriptor<T extends string = string> {
    id: T;
    label: string;
    hidden?: boolean;
    invalid?: boolean;
    badge?: number;
}

/** The visible-tab index a key moves to from `index` (the arrows wrap, Home / End jump to the ends), or null for any other key. */
const tabAfterKey = (key: string, index: number, count: number): number | null => {
    if (key === 'ArrowRight') return (index + 1) % count;
    if (key === 'ArrowLeft') return (index + count - 1) % count;
    if (key === 'Home') return 0;
    return key === 'End' ? count - 1 : null;
};

/**
 * WAI-ARIA tab row (daisyUI `tabs tabs-border`). Both settings modals build
 * their section navigation on it; the matching panels are the caller's
 * `TabPanel`s, joined to this row through the `tabId` / `panelId` builders
 * both sides share.
 *
 * The row is one non-wrapping line (`flex-nowrap overflow-x-auto`, tabs
 * `shrink-0`) so a phone scrolls it sideways instead of wrapping it;
 * `rowClassName` appends classes to it, so a caller can re-shape the line per
 * breakpoint (the global settings modal wraps its row between `sm` and `xl`).
 * A tab a filter hid gets the `hidden` attribute but stays mounted, and the
 * keyboard wraps over the visible tabs only.
 *
 * `selectionSeq` is the caller's monotonically increasing counter of user
 * selections and reveals. It — not `active` — drives the scroll-into-view:
 * the caller's `active` can also change on its own (a schema refetch while
 * filtering), and that must not yank the row. `active` alone is never a
 * scroll trigger.
 */
export function TabList<T extends string>({
    label,
    tabs,
    active,
    onSelect,
    selectionSeq,
    tabId,
    panelId,
    rowClassName = '',
}: {
    label: string;
    tabs: ReadonlyArray<TabDescriptor<T>>;
    active: T;
    onSelect: (id: T) => void;
    selectionSeq: number;
    tabId: (id: T) => string;
    panelId: (id: T) => string;
    rowClassName?: string;
}) {
    const { t } = useTranslation();
    const lastSeq = useRef(selectionSeq);

    // WAI-ARIA tabs: the tab that takes focus is the selected one.
    const onTabKeyDown = (event: TargetedKeyboardEvent<HTMLButtonElement>, id: T) => {
        const visible = tabs.filter((tab) => !tab.hidden);
        const next = tabAfterKey(
            event.key,
            visible.findIndex((tab) => tab.id === id),
            visible.length,
        );
        if (next === null) return;
        event.preventDefault();
        onSelect(visible[next].id);
        document.getElementById(tabId(visible[next].id))?.focus();
    };

    // A selection or a reveal scrolls the active tab into the row (a phone's
    // row can be wider than the screen); a derived `active` change does not.
    useEffect(() => {
        if (selectionSeq === lastSeq.current) return;
        lastSeq.current = selectionSeq;
        document.getElementById(tabId(active))?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
    });

    return (
        <div
            role="tablist"
            aria-label={label}
            className={`tabs tabs-border flex-nowrap overflow-x-auto ${rowClassName}`}
        >
            {tabs.map((tab) => (
                <button
                    key={tab.id}
                    id={tabId(tab.id)}
                    type="button"
                    role="tab"
                    hidden={tab.hidden}
                    aria-selected={active === tab.id}
                    aria-controls={panelId(tab.id)}
                    tabIndex={active === tab.id ? 0 : -1}
                    className={`tab shrink-0 ${active === tab.id ? 'tab-active' : ''}`}
                    onClick={() => onSelect(tab.id)}
                    onKeyDown={(event) => onTabKeyDown(event, tab.id)}
                >
                    {tab.label}
                    {tab.invalid && (
                        <>
                            <span className="badge badge-error badge-xs" aria-hidden="true" />
                            <span className="sr-only">{` ${t('app.tabHasErrors')}`}</span>
                        </>
                    )}
                    {tab.badge !== undefined && tab.badge > 0 && (
                        <>
                            <span className="badge badge-sm" aria-hidden="true">
                                {tab.badge}
                            </span>
                            <span className="sr-only">{` ${t('app.tabOverrideCount').replace('{0}', String(tab.badge))}`}</span>
                        </>
                    )}
                </button>
            ))}
        </div>
    );
}

/**
 * One WAI-ARIA panel of a TabList. Every panel stays mounted and the inactive
 * ones carry the `hidden` attribute, so a tab switch neither loses form drafts
 * nor the unsaved-changes state behind them. The panel opens with an sr-only
 * `h4` naming it: the modal titles itself with an `h3` and each settings group
 * inside is an `h5`, so the sr-only heading keeps the outline modal → panel →
 * group intact without showing a duplicate of the tab's name.
 */
export function TabPanel<T extends string>({
    id,
    tabId,
    panelId,
    active,
    title,
    children,
}: {
    id: T;
    tabId: (id: T) => string;
    panelId: (id: T) => string;
    active: boolean;
    title: string;
    children: ComponentChildren;
}) {
    return (
        <div role="tabpanel" id={panelId(id)} aria-labelledby={tabId(id)} hidden={!active}>
            <h4 className="sr-only">{title}</h4>
            {children}
        </div>
    );
}
