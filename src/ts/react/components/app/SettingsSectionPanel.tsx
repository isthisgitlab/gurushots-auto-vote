import { settingsPanelId, settingsTabId, useSettingsNav } from '@/contexts/SettingsNavContext';
import { TabPanel } from '@/components/ui/Tabs';

import type { ComponentChildren } from 'preact';
import type { SettingsTabId } from '@/utils/groupSettings';

/**
 * One top-level panel of the settings modal: a WAI-ARIA tab panel driven by the modal's
 * section navigation. Its content stays mounted while it is inactive or filtered out — hiding
 * it would drop a scenario draft or a title-rule edit the unsaved-changes guard still counts —
 * and the `hidden` attribute also takes it out of role queries. `title` is the display-ready
 * tab label, which names the panel's sr-only heading.
 */
export function SettingsSectionPanel({
    id,
    title,
    children,
}: {
    id: SettingsTabId;
    title: string;
    children?: ComponentChildren;
}) {
    const nav = useSettingsNav();
    return (
        <TabPanel
            id={id}
            tabId={settingsTabId}
            panelId={settingsPanelId}
            active={nav.active === id && nav.isShown(id)}
            title={title}
        >
            {children}
        </TabPanel>
    );
}
