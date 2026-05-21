/**
 * Modal's accessibility contract: it renders only when open, Escape closes it,
 * focus moves into the dialog on open, Tab / Shift+Tab cycle within it (focus
 * trap), and focus returns to the triggering element when it closes.
 */
import { fireEvent, render, screen } from '@/test/test-utils';
import { Modal } from '@/components/ui/Modal';
import { mockTranslationManager } from '../../src/js/react/test/setup';

// Modal reads the close-button label from window.translationManager (so the
// primitive works outside a provider). Pin it so the label resolves through
// the mock — which returns the key — rather than the English fallback, the
// same convention ErrorBoundary.test.jsx uses.
beforeEach(() => {
    window.translationManager = mockTranslationManager;
});

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
        const { container } = render(
            <Modal isOpen onClose={() => {}} showCloseButton={false}>
                <p>no focusable controls here</p>
            </Modal>,
        );
        const box = container.querySelector('.modal-box');
        // On open, focus falls to the box itself (tabIndex -1) since there is
        // nothing focusable inside.
        expect(document.activeElement).toBe(box);
        fireEvent.keyDown(document, { key: 'Tab' });
        expect(document.activeElement).toBe(box);
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
