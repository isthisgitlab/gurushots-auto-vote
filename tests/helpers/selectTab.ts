import { fireEvent, screen } from '../react/helpers/test-utils';

/**
 * Clicks the `role="tab"` button found by accessible name and returns it.
 * Inactive tab panels carry the `hidden` attribute and drop out of role
 * queries, so every role query into a tab other than the first needs this
 * first.
 */
export const selectTab = (name: string | RegExp): HTMLElement => {
    const tab = screen.getByRole('tab', { name });
    fireEvent.click(tab);
    return tab;
};
