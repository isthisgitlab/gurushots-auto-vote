/**
 * Tests for the shared StickyModalFooter (components/ui/StickyModalFooter) —
 * the opaque bar pinned to the bottom of a modal's scroll area, used by the
 * settings modals' action row and the photo pickers' Submit / Save.
 */

import { render } from './helpers/test-utils';
import { StickyModalFooter, STICKY_FOOTER_SCROLL_PADDING } from '@/components/ui/StickyModalFooter';

describe('StickyModalFooter', () => {
    test('renders its children in a sticky footer flush with the modal box', () => {
        const { container } = render(
            <StickyModalFooter>
                <button type="button">Go</button>
            </StickyModalFooter>,
        );
        const footer = container.firstChild as HTMLElement;
        expect(footer.className).toBe(
            'sticky -bottom-6 z-10 -mx-6 -mb-6 px-6 py-4 bg-base-100 border-t border-base-300 space-y-2',
        );
        expect(footer.querySelector('button')!.textContent).toBe('Go');
    });

    test('renders an empty footer without children', () => {
        const { container } = render(<StickyModalFooter />);
        expect((container.firstChild as HTMLElement).childElementCount).toBe(0);
    });

    test('the host scroll padding clears the footer on phones and at md', () => {
        expect(STICKY_FOOTER_SCROLL_PADDING).toBe('scroll-pb-60 md:scroll-pb-32');
    });
});
