/**
 * SettingsTierIntro — the tier band intro lines shared by both settings modals.
 */

import { render, screen } from './helpers/test-utils';
import { SettingsTierIntro } from '@/components/ui/SettingsTierIntro';

describe('SettingsTierIntro', () => {
    test('renders nothing for the unlabelled fallback band', () => {
        const { container } = render(<SettingsTierIntro id={null} />);
        expect(container.innerHTML).toBe('');
    });

    test('the unlabelled fallback band still shows the defaults note', () => {
        render(<SettingsTierIntro id={null} defaultsNote />);
        expect(screen.getByText('app.tierDefaultsNote')).toBeTruthy();
        expect(screen.queryByText('app.tierOverridesDesc')).toBeNull();
    });

    test('renders no heading and nothing at all for a named band with no line to show', () => {
        const { container } = render(<SettingsTierIntro id="core" />);
        expect(container.querySelector('h4')).toBeNull();
        expect(container.querySelector('h5')).toBeNull();
        expect(container.innerHTML).toBe('');
    });

    test('the overrides band carries its sub-line', () => {
        render(<SettingsTierIntro id="overrides" />);
        expect(screen.getByText('app.tierOverridesDesc')).toBeTruthy();
    });

    test('the defaults note shows only when the caller opts in', () => {
        render(<SettingsTierIntro id="core" defaultsNote />);
        expect(screen.getByText('app.tierDefaultsNote')).toBeTruthy();
        expect(screen.queryByText('app.tierOverridesDesc')).toBeNull();
    });

    test('the overrides band of the global modal shows both lines', () => {
        render(<SettingsTierIntro id="overrides" defaultsNote />);
        expect(screen.getByText('app.tierOverridesDesc')).toBeTruthy();
        expect(screen.getByText('app.tierDefaultsNote')).toBeTruthy();
    });
});
