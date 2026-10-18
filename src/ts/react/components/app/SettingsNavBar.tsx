import { useTranslation } from '@/contexts/TranslationContext';
import { SETTINGS_SECTIONS, SETTINGS_SECTION_TITLES, useSettingsNav } from '@/contexts/SettingsNavContext';

// The modal box's scroll padding for the bar pinned at the top of the settings body, next to
// STICKY_FOOTER_SCROLL_PADDING: a jump, a Tab focus or a Save-failure focus must not land under it. The bar is
// the jump row plus the filter field stacked on a phone (about 5rem with its padding), one row from `sm`
// (about 3rem); each includes room for the focus ring.
export const SETTINGS_NAV_SCROLL_PADDING = 'scroll-pt-24 sm:scroll-pt-16';

/**
 * The bar pinned at the top of the settings modal's body: a jump button per section in one scrollable row, and the
 * filter field. It takes the footer's treatment: opaque, flush with the box edges.
 */
export function SettingsNavBar() {
    const { t } = useTranslation();
    const nav = useSettingsNav();
    return (
        <div className="sticky -top-6 z-10 -mx-6 mb-4 px-6 py-2 bg-base-100 border-b border-base-300 flex flex-col gap-2 sm:flex-row sm:items-center">
            <div
                role="group"
                aria-label={t('app.settingsJumpLabel')}
                className="flex flex-nowrap gap-1 overflow-x-auto sm:flex-1 sm:min-w-0"
            >
                {SETTINGS_SECTIONS.map((id) => (
                    <button
                        key={id}
                        type="button"
                        className={`btn btn-xs shrink-0 ${nav.shown[id] ? '' : 'hidden'}`}
                        onClick={() => nav.jumpTo(id)}
                    >
                        {t(SETTINGS_SECTION_TITLES[id])}
                    </button>
                ))}
            </div>
            <input
                type="search"
                className="input input-sm w-full sm:w-56"
                placeholder={t('app.settingsFilterPlaceholder')}
                aria-label={t('app.settingsFilterPlaceholder')}
                autoComplete="off"
                spellcheck={false}
                value={nav.query}
                onChange={(e) => nav.setQuery(e.currentTarget.value)}
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
