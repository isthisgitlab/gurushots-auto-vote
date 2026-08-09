/**
 * Tests for the shared ModalActionRow (components/ui/ModalActionRow) —
 * the Save / secondary / Cancel row used twice by SettingsModal and once
 * by ChallengeSettingsModal. Asserts the class strings and handler
 * wiring match the previous inline copies.
 */

import { render, fireEvent } from './helpers/test-utils';
import { ModalActionRow } from '@/components/ui/ModalActionRow';

const renderRow = (over = {}) => {
    const props = {
        onSave: jest.fn(),
        saving: false,
        onSecondary: jest.fn(),
        secondaryLabel: 'app.resetAll',
        onCancel: jest.fn(),
        ...over,
    };
    const utils = render(<ModalActionRow {...props} />);
    return { props, ...utils };
};

describe('ModalActionRow', () => {
    test('renders Save / secondary / Cancel and wires the handlers', () => {
        const { props, container } = renderRow();
        const buttons = Array.from(container.querySelectorAll('button'));
        expect(buttons).toHaveLength(3);

        const [save, secondary, cancel] = buttons;
        expect(save.className).toBe('btn btn-latvian');
        expect(save.textContent).toContain('app.save');
        expect(secondary.className).toBe('btn btn-warning');
        expect(secondary.textContent).toContain('app.resetAll');
        expect(cancel.className).toBe('btn');
        expect(cancel.textContent).toContain('app.cancel');

        fireEvent.click(save);
        fireEvent.click(secondary);
        fireEvent.click(cancel);
        expect(props.onSave).toHaveBeenCalledTimes(1);
        expect(props.onSecondary).toHaveBeenCalledTimes(1);
        expect(props.onCancel).toHaveBeenCalledTimes(1);
    });

    test('saving disables Save and shows the spinner', () => {
        const { container } = renderRow({ saving: true });
        const save = container.querySelector('button');
        expect(save.disabled).toBe(true);
        expect(save.querySelector('.loading.loading-spinner')).not.toBeNull();
    });

    test('bordered variant adds the top border classes to the row', () => {
        const { container } = renderRow({ bordered: true });
        expect(container.firstChild.className).toBe('flex justify-end gap-2 pt-4 border-t border-base-300');
    });

    test('default (top) variant has no border classes', () => {
        const { container } = renderRow();
        expect(container.firstChild.className).toBe('flex justify-end gap-2');
    });

    test('secondaryIcon="trash" swaps the warning-button glyph', () => {
        const { container } = renderRow({ secondaryIcon: 'trash', secondaryLabel: 'app.clearAll' });
        const secondary = container.querySelectorAll('button')[1];
        const path = secondary.querySelector('svg path');
        expect(path.getAttribute('d')).toMatch(/^M19 7l/); // trash outline, not the reset arrows
    });
});
