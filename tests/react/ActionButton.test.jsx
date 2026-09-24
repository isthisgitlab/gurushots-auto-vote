import { render, fireEvent } from './helpers/test-utils';
import { ActionButton } from '@/components/ui/ActionButton';

test.each(['accent', 'info', 'success', 'warning'])('uses the %s variant until an action fails', (variant) => {
    const { container, rerender } = render(<ActionButton variant={variant}>Go</ActionButton>);
    const button = container.querySelector('button');

    expect(button.className).toBe(`btn btn-sm btn-${variant}`);

    rerender(
        <ActionButton variant={variant} error="Failed">
            Go
        </ActionButton>,
    );
    expect(button.className).toBe('btn btn-sm btn-error');
});

test('preserves extra classes and native button properties', () => {
    const onClick = jest.fn();
    const { container } = render(
        <ActionButton variant="info" className="mt-1" type="button" title="Run" onClick={onClick}>
            Run
        </ActionButton>,
    );
    const button = container.querySelector('button');

    expect(button.className).toBe('btn btn-sm btn-info mt-1');
    expect(button.type).toBe('button');
    expect(button.title).toBe('Run');
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
});
