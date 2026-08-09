/**
 * Tests for the shared ResetButton / ResetIcon (components/ui/ResetButton).
 * The button must render the exact DaisyUI markup the inline copies
 * produced (btn btn-ghost btn-sm + w-4 h-4 svg) so extraction stayed
 * visually identical.
 */

import { render, fireEvent } from './helpers/test-utils';
import { ResetButton, ResetIcon } from '@/components/ui/ResetButton';

describe('ResetButton', () => {
    test('renders the ghost button with title and reset icon', () => {
        const onClick = jest.fn();
        const { container } = render(<ResetButton title="app.resetToDefaultNotSaved" onClick={onClick} />);

        const button = container.querySelector('button');
        expect(button.className).toBe('btn btn-ghost btn-sm');
        expect(button.getAttribute('title')).toBe('app.resetToDefaultNotSaved');
        const svg = button.querySelector('svg');
        expect(svg).not.toBeNull();
        expect(svg.getAttribute('class')).toBe('w-4 h-4');
    });

    test('omits the title attribute when no title is given', () => {
        const { container } = render(<ResetButton onClick={jest.fn()} />);
        expect(container.querySelector('button').hasAttribute('title')).toBe(false);
    });

    test('fires onClick', () => {
        const onClick = jest.fn();
        const { container } = render(<ResetButton onClick={onClick} />);
        fireEvent.click(container.querySelector('button'));
        expect(onClick).toHaveBeenCalledTimes(1);
    });
});

describe('ResetIcon', () => {
    test('accepts a custom class for the action-row variant', () => {
        const { container } = render(<ResetIcon className="w-4 h-4 mr-2" />);
        expect(container.querySelector('svg').getAttribute('class')).toBe('w-4 h-4 mr-2');
    });
});
