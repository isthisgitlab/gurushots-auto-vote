import { render, fireEvent } from './helpers/test-utils';
import { ActionButton } from '@/components/ui/ActionButton';
import { ICON_PATHS } from '@/components/ui/StrokeIcon';

test.each([
    ['neutral', 'btn-neutral'],
    ['cost', 'btn-latvian'],
] as const)('uses the %s variant until an action fails', (variant, expected) => {
    const { container, rerender } = render(<ActionButton variant={variant}>Go</ActionButton>);
    const button = container.querySelector('button')!;

    expect(button.className).toBe(`btn btn-sm ${expected}`);

    rerender(
        <ActionButton variant={variant} error="Failed">
            Go
        </ActionButton>,
    );
    expect(button.className).toBe('btn btn-sm btn-error');
});

test('a failed action adds an error icon, so the button no longer reads as the idle solid-red cost button', () => {
    const { container, rerender } = render(<ActionButton variant="cost">Go</ActionButton>);
    expect(container.querySelector('svg')).toBeNull();

    rerender(
        <ActionButton variant="cost" error="Failed">
            Go
        </ActionButton>,
    );
    const icon = container.querySelector('button > svg')!;
    expect(icon.getAttribute('aria-hidden')).toBe('true');
    expect(icon.querySelector('path')!.getAttribute('d')).toBe(ICON_PATHS.xCircle);
    expect(container.querySelector('button')!.textContent).toBe('Go');
});

test('preserves extra classes and native button properties', () => {
    const onClick = jest.fn();
    const { container } = render(
        <ActionButton variant="neutral" className="mt-1" type="button" title="Run" onClick={onClick}>
            Run
        </ActionButton>,
    );
    const button = container.querySelector('button')!;

    expect(button.className).toBe('btn btn-sm btn-neutral mt-1');
    expect(button.type).toBe('button');
    expect(button.title).toBe('Run');
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
});
