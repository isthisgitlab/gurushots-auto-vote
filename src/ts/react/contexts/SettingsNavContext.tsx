import { createContext, useCallback, useContext, useState } from 'react';
import { bandTabs } from '@/utils/groupSettings';

import type { SettingsBand, SettingsTab, SettingsTabId } from '@/utils/groupSettings';

/**
 * The translation key of each fixed section's title — its tab's label and the sr-only heading
 * of its panel. The tier tabs' titles come from their band's label instead (see bandTabs).
 */
export const SETTINGS_SECTION_TITLES = {
    application: 'app.applicationSettings',
    titleRules: 'app.titleTagRules',
    profiles: 'app.challengeProfiles',
    scenarios: 'app.scenarios',
} as const;

/**
 * The global settings modal's sections in tab order: Application, one tab per non-app tier
 * band, then the fixed title-rules, profiles and scenarios tabs. Built from the modal's bands,
 * because which tier tabs exist depends on the schema the main process sent.
 */
export const settingsSections = (bands: readonly SettingsBand[]): SettingsTab[] => [
    { id: 'application', label: SETTINGS_SECTION_TITLES.application },
    ...bandTabs(bands),
    { id: 'titleRules', label: SETTINGS_SECTION_TITLES.titleRules },
    { id: 'profiles', label: SETTINGS_SECTION_TITLES.profiles },
    { id: 'scenarios', label: SETTINGS_SECTION_TITLES.scenarios },
];

/**
 * The tab button's and the panel's DOM id for a section id. The `settings-` prefix keeps the
 * two settings modals' ids apart while both are mounted.
 */
export const settingsTabId = (id: SettingsTabId): string => `settings-tab-${id}`;
export const settingsPanelId = (id: SettingsTabId): string => `settings-panel-${id}`;

/**
 * The section navigation the settings modal shares with its sections and cells: the filter
 * text, the active tab and which tabs match the filter. Nothing is unmounted to hide a
 * section (that would drop a scenario draft or a title-rule edit the unsaved-changes guard
 * still counts): a tab or panel the filter excluded carries the `hidden` attribute.
 */
export type SettingsNav = {
    /** The filter text; blank when nothing is filtered. */
    query: string;
    /**
     * Whether to search names only. The name check spans the whole modal, so one name match
     * anywhere turns off description matches in every tab. False while the filter is blank.
     */
    namesOnly: boolean;
    /** Whether a section survives the current filter (always true without one). */
    isShown: (id: SettingsTabId) => boolean;
    /** The section whose panel is on screen: the selected one, or the first shown one when a refetch or a language change hid the selection. */
    active: SettingsTabId;
    /** The user's selections and reveals so far: it — not `active` — drives the tab row's scroll-into-view. */
    selectionSeq: number;
    select: (id: SettingsTabId) => void;
    setQuery: (query: string) => void;
    /** Clear the filter and select a section, for the caller to focus something in it once it has rendered. */
    reveal: (id: SettingsTabId) => void;
    /** Back to a freshly opened modal: Application, no filter. */
    reset: () => void;
};

const noop = () => undefined;

// Outside the settings modal (the per-challenge modal shares its cells): no filter, every
// section shown, Application active. Tests that need a visible panel wrap with a provider.
const SettingsNavContext = createContext<SettingsNav>({
    query: '',
    namesOnly: false,
    isShown: () => true,
    active: 'application',
    selectionSeq: 0,
    select: noop,
    setQuery: noop,
    reveal: noop,
    reset: noop,
});

export const SettingsNavProvider = SettingsNavContext.Provider;

export const useSettingsNav = (): SettingsNav => useContext(SettingsNavContext);

/**
 * The state behind SettingsNavProvider. `matched` says, for a filter text, whether a section has
 * a match under the names-only rule; `nameMatched` says whether the query matches a name anywhere
 * in the modal (the check behind `namesOnly`); `sections` is the tab order the active-tab
 * fallback follows.
 */
export function useSettingsNavState(
    sections: readonly SettingsTabId[],
    matched: (query: string, id: SettingsTabId, namesOnly: boolean) => boolean,
    nameMatched: (query: string) => boolean,
): SettingsNav {
    const [query, setQueryState] = useState('');
    const [selected, setSelected] = useState<SettingsTabId>('application');
    const [selectionSeq, setSelectionSeq] = useState(0);

    const namesOnly = query.trim() !== '' && nameMatched(query);
    const isShown = (id: SettingsTabId) => query.trim() === '' || matched(query, id, namesOnly);

    // A filter — or a schema refetch or language change re-evaluating it — can hide the
    // selected tab; the first shown one takes over, so a hidden tab is never the active one.
    const active = isShown(selected) ? selected : (sections.find(isShown) ?? selected);

    const setQuery = (next: string) => {
        setQueryState(next);
        // Clearing the filter keeps the tab that was active.
        if (next.trim() === '') setSelected(active);
    };

    const select = (id: SettingsTabId) => {
        setSelected(id);
        setSelectionSeq((seq) => seq + 1);
    };

    const reveal = (id: SettingsTabId) => {
        setQueryState('');
        setSelected(id);
        setSelectionSeq((seq) => seq + 1);
    };

    const reset = useCallback(() => {
        setQueryState('');
        setSelected('application');
    }, []);

    return { query, namesOnly, isShown, active, selectionSeq, select, setQuery, reveal, reset };
}
