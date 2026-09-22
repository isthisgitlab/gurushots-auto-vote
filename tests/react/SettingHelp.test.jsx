/**
 * SettingHelp renders an optional <details> disclosure for a settings row.
 * The translation mock echoes keys, so rendered text is the i18n key.
 */

import { render, screen } from './helpers/test-utils';
import { SettingHelp } from '@/components/ui/SettingHelp';

describe('SettingHelp', () => {
    test('renders nothing without a helpKey', () => {
        const { container } = render(<SettingHelp />);
        expect(container.innerHTML).toBe('');
    });

    test('renders a disclosure with the label and the translated help text', () => {
        const { container } = render(<SettingHelp helpKey="app.exposureHelp" />);
        const details = container.querySelector('details');
        expect(details).not.toBeNull();
        expect(details.querySelector('summary').textContent).toContain('app.settingHelpLabel');
        expect(screen.getByText('app.exposureHelp').tagName).toBe('P');
    });
});
