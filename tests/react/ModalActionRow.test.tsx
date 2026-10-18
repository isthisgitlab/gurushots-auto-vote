/**
 * Tests for the shared ModalActionRow (components/ui/ModalActionRow) —
 * the sticky Save / secondary / Cancel footer used by SettingsModal and
 * ChallengeSettingsModal. Asserts the footer classes, the optional save-error
 * alert, the button styles and handler wiring.
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
    test('renders secondary / Cancel / Save, with the secondary apart on the left, and wires the handlers', () => {
        const { props, container } = renderRow();
        const buttons = Array.from(container.querySelectorAll('button'));
        expect(buttons).toHaveLength(3);

        const [secondary, cancel, save] = buttons;
        expect(save.className).toBe('btn btn-neutral btn-sm');
        expect(save.textContent).toContain('app.save');
        expect(secondary.className).toBe('btn btn-error btn-sm');
        expect(secondary.textContent).toContain('app.resetAll');
        expect(cancel.className).toBe('btn btn-outline btn-sm');
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
        const save = container.querySelectorAll('button')[2];
        expect(save.disabled).toBe(true);
        expect(save.querySelector('.loading.loading-spinner')).not.toBeNull();
    });

    test('renders as a sticky footer flush with the modal box', () => {
        const { container } = renderRow();
        expect((container.firstChild as HTMLElement).className).toBe(
            'sticky -bottom-6 z-10 -mx-6 -mb-6 px-6 py-4 bg-base-100 border-t border-base-300 space-y-2',
        );
    });

    test('the buttons wrap instead of overflowing a narrow modal', () => {
        const { container } = renderRow();
        expect(container.querySelector('button')!.parentElement!.parentElement!.className).toBe(
            'flex flex-wrap justify-end gap-2',
        );
    });

    test('the secondary sits apart on the left and takes the first row below sm, Cancel and Save wrapping together', () => {
        const { container } = renderRow();
        const [secondary, cancel, save] = Array.from(container.querySelectorAll('button'));
        expect(secondary.parentElement!.className).toBe('mr-auto max-sm:basis-full');
        expect(cancel.parentElement).toBe(save.parentElement);
        expect(cancel.nextElementSibling).toBe(save);
    });

    test('saveError renders the alert above the buttons; omitted by default', () => {
        const off = renderRow();
        expect(off.container.querySelector('[role="alert"]')).toBeNull();
        off.unmount();

        const { container } = renderRow({ saveError: true });
        const alert = container.querySelector('[role="alert"]')!;
        expect(alert.textContent).toBe('app.settingsSaveError');
        expect(alert.compareDocumentPosition(container.querySelector('button')!)).toBe(
            Node.DOCUMENT_POSITION_FOLLOWING,
        );
    });

    test('secondaryIcon="trash" swaps the destructive-button glyph', () => {
        const { container } = renderRow({ secondaryIcon: 'trash', secondaryLabel: 'app.clearAll' });
        const secondary = container.querySelector('button')!;
        const path = secondary.querySelector('svg path')!;
        expect(path.getAttribute('d')).toMatch(/^M19 7l/); // trash outline, not the reset arrows
    });
});
