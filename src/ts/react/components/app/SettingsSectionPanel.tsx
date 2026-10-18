import { useTranslation } from '@/contexts/TranslationContext';
import {
    SETTINGS_SECTION_TITLES,
    settingsContentId,
    settingsToggleId,
    useSettingsNav,
} from '@/contexts/SettingsNavContext';

import type { ComponentChildren } from 'preact';
import type { SettingsSectionId } from '@/contexts/SettingsNavContext';

/**
 * One top-level section of the settings modal: a daisyUI collapse driven by the modal's section navigation.
 * Its content stays mounted while it is closed (`collapse-close`) or filtered out (`hidden`). The heading is the
 * collapse's direct child, so daisyUI draws and turns the arrow on it; the button inside spans it, so the whole
 * header toggles. `headingId` makes the heading a focus target for a Save that failed on a part with no input.
 */
export function SettingsSectionPanel({
    id,
    headingId,
    children,
}: {
    id: SettingsSectionId;
    headingId?: string;
    children?: ComponentChildren;
}) {
    const { t } = useTranslation();
    const nav = useSettingsNav();
    const open = nav.open[id];
    return (
        <div
            className={`collapse collapse-arrow border border-base-300 ${open ? 'collapse-open' : 'collapse-close'} ${nav.instant === id ? 'transition-none' : ''} ${nav.shown[id] ? '' : 'hidden'}`}
        >
            <h4 id={headingId} tabIndex={-1} className="collapse-title p-0 font-semibold text-base">
                <button
                    type="button"
                    id={settingsToggleId(id)}
                    aria-expanded={open}
                    aria-controls={settingsContentId(id)}
                    className="p-4 pe-12 w-full text-left"
                    onClick={() => nav.toggle(id)}
                >
                    {t(SETTINGS_SECTION_TITLES[id])}
                </button>
            </h4>
            <div id={settingsContentId(id)} className="collapse-content">
                {children}
            </div>
        </div>
    );
}
