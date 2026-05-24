/**
 * Unit tests for the StatusBadge presentational component.
 *
 * StatusBadge is pure (no hooks, no window.api), so it mounts with the
 * shared render wrapper and no mocks. These cover the variant/size class
 * mapping and that icon + text children render verbatim — the challenge-card
 * badge row relies on it to show every chip as visible icon + text.
 */

import { render } from '@/test/test-utils';
import { StatusBadge } from '@/components/ui/StatusBadge';

const badge = (container) => container.querySelector('span.badge');

describe('StatusBadge', () => {
    test('renders icon + text children with the variant and size classes', () => {
        const { container } = render(
            <StatusBadge variant="success" size="xs">
                📥 hello
            </StatusBadge>,
        );
        const span = badge(container);
        expect(span).toBeTruthy();
        expect(span.className).toMatch(/badge-success/);
        expect(span.className).toMatch(/badge-xs/);
        expect(span.textContent).toBe('📥 hello');
    });

    test('falls back to neutral variant for an unknown variant', () => {
        const { container } = render(<StatusBadge variant="nope">x</StatusBadge>);
        expect(badge(container).className).toMatch(/badge-neutral/);
    });
});
