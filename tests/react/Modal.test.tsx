/**
 * Modal's accessibility contract: it renders only when open, Escape closes it,
 * focus moves into the dialog on open, Tab / Shift+Tab cycle within it (focus
 * trap), and focus returns to the triggering element when it closes.
 */
import { fireEvent, render, screen } from './helpers/test-utils';
import { Modal } from '@/components/ui/Modal';

describe('Modal', () => {
    test('renders nothing when closed', () => {
        const { container } = render(
            <Modal isOpen={false} onClose={() => {}}>
                <button type="button">inside</button>
            </Modal>,
        );
        expect(container.querySelector('.modal-box')).toBeNull();
    });

    test('renders title and children when open', () => {
        render(
            <Modal isOpen onClose={() => {}} title="My Dialog">
                <button type="button">inside</button>
            </Modal>,
        );
        expect(screen.getByText('My Dialog')).toBeTruthy();
        expect(screen.getByText('inside')).toBeTruthy();
        expect(screen.getByRole('dialog')).toBeTruthy();
    });

    test('Escape calls onClose', () => {
        const onClose = jest.fn();
        render(
            <Modal isOpen onClose={onClose} title="T">
                <button type="button">inside</button>
            </Modal>,
        );
        fireEvent.keyDown(document, { key: 'Escape' });
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    test('moves focus into the dialog on open', () => {
        render(
            <Modal isOpen onClose={() => {}} title="T">
                <button type="button">inside</button>
            </Modal>,
        );
        // First focusable is the close button (rendered before children).
        expect(document.activeElement).toBe(screen.getByLabelText('common.closeModal'));
    });

    test('Tab on the last focusable wraps to the first (focus trap)', () => {
        render(
            <Modal isOpen onClose={() => {}} title="T">
                <button type="button">inside</button>
            </Modal>,
        );
        const closeBtn = screen.getByLabelText('common.closeModal');
        const inside = screen.getByText('inside');

        inside.focus();
        expect(document.activeElement).toBe(inside);
        fireEvent.keyDown(document, { key: 'Tab' });
        expect(document.activeElement).toBe(closeBtn);
    });

    test('Shift+Tab on the first focusable wraps to the last (focus trap)', () => {
        render(
            <Modal isOpen onClose={() => {}} title="T">
                <button type="button">inside</button>
            </Modal>,
        );
        const closeBtn = screen.getByLabelText('common.closeModal');
        const inside = screen.getByText('inside');

        closeBtn.focus();
        fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
        expect(document.activeElement).toBe(inside);
    });

    test('with no focusable children, Tab keeps focus pinned on the dialog box', () => {
        render(
            <Modal isOpen onClose={() => {}} showCloseButton={false}>
                <p>no focusable controls here</p>
            </Modal>,
        );
        const box = document.querySelector('.modal-box');
        // On open, focus falls to the box itself (tabIndex -1) since there is
        // nothing focusable inside.
        expect(document.activeElement).toBe(box);
        fireEvent.keyDown(document, { key: 'Tab' });
        expect(document.activeElement).toBe(box);
    });

    test('a new onClose identity on re-render does not pull focus back to the first control', () => {
        const first = jest.fn();
        const { rerender } = render(
            <Modal isOpen onClose={first} title="T">
                <button type="button">inside</button>
            </Modal>,
        );
        const inside = screen.getByText('inside');
        inside.focus();
        expect(document.activeElement).toBe(inside);

        const second = jest.fn();
        rerender(
            <Modal isOpen onClose={second} title="T">
                <button type="button">inside</button>
            </Modal>,
        );
        // Focus stays where the user put it, and Escape reaches the handler now in force.
        expect(document.activeElement).toBe(inside);
        fireEvent.keyDown(document, { key: 'Escape' });
        expect(first).not.toHaveBeenCalled();
        expect(second).toHaveBeenCalledTimes(1);
    });

    test('focus moves into the dialog once per opening', () => {
        const { rerender } = render(
            <Modal isOpen={false} onClose={() => {}} title="T">
                <button type="button">inside</button>
            </Modal>,
        );
        rerender(
            <Modal isOpen onClose={() => {}} title="T">
                <button type="button">inside</button>
            </Modal>,
        );
        expect(document.activeElement).toBe(screen.getByLabelText('common.closeModal'));
        screen.getByText('inside').focus();
        rerender(
            <Modal isOpen onClose={() => {}} title="T2">
                <button type="button">inside</button>
            </Modal>,
        );
        expect(document.activeElement).toBe(screen.getByText('inside'));
    });

    test('renders into the document body, so a modal opened inside another is not nested in its box', () => {
        const { container } = render(
            <Modal isOpen onClose={() => {}} title="Outer">
                <Modal isOpen onClose={() => {}} title="Inner">
                    <p>inner body</p>
                </Modal>
            </Modal>,
        );
        // Nothing lands in the render container...
        expect(container.querySelector('.modal')).toBeNull();
        // ...both dialogs are direct children of the body, and the inner is not inside the outer box.
        const dialogs = Array.from(document.body.querySelectorAll(':scope > .modal'));
        expect(dialogs).toHaveLength(2);
        const outerBox = dialogs.find((d) => d.textContent?.includes('Outer') && !d.querySelector('.modal'));
        expect(outerBox).toBeTruthy();
        expect(outerBox!.contains(screen.getByText('inner body'))).toBe(false);
    });

    test('restores focus to the trigger element when closed', () => {
        const trigger = document.createElement('button');
        document.body.appendChild(trigger);
        trigger.focus();
        expect(document.activeElement).toBe(trigger);

        const { rerender } = render(
            <Modal isOpen={false} onClose={() => {}} title="T">
                <button type="button">inside</button>
            </Modal>,
        );

        rerender(
            <Modal isOpen onClose={() => {}} title="T">
                <button type="button">inside</button>
            </Modal>,
        );
        // Focus moved into the dialog, away from the trigger.
        expect(document.activeElement).not.toBe(trigger);

        rerender(
            <Modal isOpen={false} onClose={() => {}} title="T">
                <button type="button">inside</button>
            </Modal>,
        );
        // Closing returns focus to the trigger.
        expect(document.activeElement).toBe(trigger);

        trigger.remove();
    });
});
