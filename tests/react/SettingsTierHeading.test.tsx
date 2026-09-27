/**
 * SettingsTierHeading — the tier band heading shared by both settings modals.
 */

import { render, screen } from './helpers/test-utils';
import { SettingsTierHeading } from '@/components/ui/SettingsTierHeading';

describe('SettingsTierHeading', () => {
    test('renders nothing for the unlabelled fallback band', () => {
        const { container } = render(<SettingsTierHeading id={null} label={null} />);
        expect(container.innerHTML).toBe('');
    });

    test('defaults to an h5 heading when no level is passed', () => {
        render(<SettingsTierHeading id="core" label="app.tierCore" />);
        expect(screen.getByRole('heading', { level: 5, name: 'app.tierCore' })).toBeTruthy();
        expect(screen.queryByText('app.tierOverridesDesc')).toBeNull();
    });

    test('honours an explicit level and adds the sub-line on the overrides band', () => {
        render(<SettingsTierHeading id="overrides" label="app.tierOverrides" level="h4" />);
        expect(screen.getByRole('heading', { level: 4, name: 'app.tierOverrides' })).toBeTruthy();
        expect(screen.getByText('app.tierOverridesDesc')).toBeTruthy();
    });
});
