import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { scrollBehavior } from '@/utils/scrollBehavior';

/**
 * The global settings modal's top-level sections, in the order they render.
 */
export const SETTINGS_SECTIONS = ['application', 'challengeDefaults', 'titleRules', 'scenarios', 'about'] as const;

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number];

type SectionFlags = Record<SettingsSectionId, boolean>;

/**
 * The translation key of each section's heading, which is also its jump button's label.
 */
export const SETTINGS_SECTION_TITLES: Record<SettingsSectionId, string> = {
    application: 'app.applicationSettings',
    challengeDefaults: 'app.challengeDefaults',
    titleRules: 'app.titleTagRules',
    scenarios: 'app.scenarios',
    about: 'about.title',
};

/**
 * The element ids of a section's toggle button and of the content it shows and hides.
 */
export const settingsToggleId = (id: SettingsSectionId): string => `settings-section-${id}-toggle`;
export const settingsContentId = (id: SettingsSectionId): string => `settings-section-${id}-content`;

const flags = (value: boolean): SectionFlags => ({
    application: value,
    challengeDefaults: value,
    titleRules: value,
    scenarios: value,
    about: value,
});

// What a freshly opened modal shows: the Application section only.
const INITIAL_OPEN: SectionFlags = { ...flags(false), application: true };

/**
 * The section navigation the settings modal shares with its sections and cells: the filter text, which sections
 * match it and which are open. Nothing is unmounted to hide it (that would drop a scenario draft or a title-rule
 * edit the unsaved-changes guard still counts): a collapsed section is `collapse-close`, a filtered-out one `hidden`.
 */
export type SettingsNav = {
    /** The filter text; blank when nothing is filtered. */
    query: string;
    /** Whether each section has anything matching the filter (all true without one). */
    shown: SectionFlags;
    open: SectionFlags;
    /** The section just opened from code: it opens without the animation, so the focus that follows lands right. */
    instant: SettingsSectionId | null;
    toggle: (id: SettingsSectionId) => void;
    setQuery: (query: string) => void;
    /** Open a section, scroll to it and focus its toggle. */
    jumpTo: (id: SettingsSectionId) => void;
    /** Clear the filter and open a section, for the caller to focus something in it once it has rendered. */
    reveal: (id: SettingsSectionId) => void;
    /** Re-enable the open animation: called once the focus or scroll after a programmatic open has forced layout. */
    settle: () => void;
    /** Back to a freshly opened modal: no filter, only Application open. */
    reset: () => void;
};

const noop = () => undefined;

// Outside the settings modal (the per-challenge modal shares its cells): no filter and everything open.
const SettingsNavContext = createContext<SettingsNav>({
    query: '',
    shown: flags(true),
    open: flags(true),
    instant: null,
    toggle: noop,
    setQuery: noop,
    jumpTo: noop,
    reveal: noop,
    settle: noop,
    reset: noop,
});

export const SettingsNavProvider = SettingsNavContext.Provider;

export const useSettingsNav = (): SettingsNav => useContext(SettingsNavContext);

/**
 * The state behind SettingsNavProvider. `matchedSections` says, for a filter text, which sections have a match.
 */
export function useSettingsNavState(matchedSections: (query: string) => SectionFlags): SettingsNav {
    const [query, setQueryState] = useState('');
    const [open, setOpen] = useState(INITIAL_OPEN);
    const [instant, setInstant] = useState<SettingsSectionId | null>(null);
    const [jump, setJump] = useState<SettingsSectionId | null>(null);
    // The open sections from before the filter started: they come back when it is cleared.
    const before = useRef<SectionFlags | null>(null);

    const filtering = query.trim() !== '';

    const setQuery = (next: string) => {
        setQueryState(next);
        if (next.trim() === '') {
            if (before.current) setOpen(before.current);
            before.current = null;
            return;
        }
        before.current ??= open;
        setOpen(matchedSections(next));
    };

    const reveal = (id: SettingsSectionId) => {
        const restored = before.current ?? open;
        before.current = null;
        setQueryState('');
        setOpen({ ...restored, [id]: true });
        setInstant(id);
    };

    const jumpTo = (id: SettingsSectionId) => {
        setOpen({ ...open, [id]: true });
        setInstant(id);
        setJump(id);
    };

    // After the render that opened the section: it is a mounted element either way, so only its layout is new.
    useEffect(() => {
        if (!jump) return;
        setJump(null);
        const toggleButton = document.getElementById(settingsToggleId(jump)) as HTMLElement;
        toggleButton.scrollIntoView({ block: 'start', behavior: scrollBehavior() });
        toggleButton.focus({ preventScroll: true });
        setInstant(null);
    }, [jump]);

    const settle = useCallback(() => setInstant(null), []);

    const reset = useCallback(() => {
        before.current = null;
        setQueryState('');
        setOpen(INITIAL_OPEN);
        setInstant(null);
        setJump(null);
    }, []);

    return {
        query,
        shown: filtering ? matchedSections(query) : flags(true),
        open,
        instant,
        toggle: (id) => setOpen({ ...open, [id]: !open[id] }),
        setQuery,
        jumpTo,
        reveal,
        settle,
        reset,
    };
}
