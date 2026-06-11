/**
 * Component tests for ScrollToTopButton.jsx — the floating back-to-top button
 * on the window-scrolled main page. Covers:
 *   - hidden while the page is at (or near) the top
 *   - appears once scrolled past the threshold, including when mounted on an
 *     already-scrolled page
 *   - clicking smooth-scrolls the window back to the top
 *   - hides again when the page returns to the top
 */

import { render, screen, fireEvent } from '@/test/test-utils';
import { ScrollToTopButton } from '@/components/ui/ScrollToTopButton';

const setScrollY = (value) => {
    Object.defineProperty(window, 'scrollY', { value, writable: true, configurable: true });
};

describe('ScrollToTopButton', () => {
    afterEach(() => {
        jest.restoreAllMocks();
        setScrollY(0);
    });

    test('renders nothing while the page is at the top', () => {
        render(<ScrollToTopButton />);

        expect(screen.queryByRole('button')).toBeNull();
    });

    test('appears after scrolling past the threshold', () => {
        render(<ScrollToTopButton />);

        setScrollY(400);
        fireEvent.scroll(window);

        expect(screen.getByRole('button', { name: 'app.scrollToTop' })).toBeTruthy();
    });

    test('is visible immediately when mounted on an already-scrolled page', () => {
        setScrollY(400);

        render(<ScrollToTopButton />);

        expect(screen.getByRole('button', { name: 'app.scrollToTop' })).toBeTruthy();
    });

    test('stays hidden below the threshold', () => {
        render(<ScrollToTopButton />);

        setScrollY(200);
        fireEvent.scroll(window);

        expect(screen.queryByRole('button')).toBeNull();
    });

    test('clicking scrolls the window smoothly to the top', () => {
        const scrollTo = jest.spyOn(window, 'scrollTo').mockImplementation(() => {});
        setScrollY(400);

        render(<ScrollToTopButton />);
        fireEvent.click(screen.getByRole('button', { name: 'app.scrollToTop' }));

        expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'smooth' });
    });

    test('hides again when the page returns to the top', () => {
        setScrollY(400);
        render(<ScrollToTopButton />);
        expect(screen.getByRole('button', { name: 'app.scrollToTop' })).toBeTruthy();

        setScrollY(0);
        fireEvent.scroll(window);

        expect(screen.queryByRole('button')).toBeNull();
    });
});
