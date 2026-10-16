/**
 * FocusDropdown (ui/FocusDropdown.tsx) — a DaisyUI dropdown that opens on focus within and, for engines that do not
 * focus a button on click (WebKit), on activation of the trigger; it closes on focus-out, on a press outside it and
 * on Escape.
 */
import { fireEvent, render, screen } from './helpers/test-utils';
import { FocusDropdown } from '@/components/ui/FocusDropdown';

const renderDropdown = () =>
    render(
        <div>
            <button type="button">outside</button>
            <FocusDropdown trigger="Menu" triggerClassName="btn" menuClassName="menu">
                <li>
                    <button type="button">entry</button>
                </li>
            </FocusDropdown>
        </div>,
    );

const wrapper = () => screen.getByRole('button', { name: 'Menu' }).closest('.dropdown') as HTMLElement;
const trigger = () => screen.getByRole('button', { name: 'Menu' });

test('a click that never focuses the trigger still opens it (dropdown-open), and says so', () => {
    renderDropdown();
    expect(wrapper().classList.contains('dropdown-open')).toBe(false);
    expect(trigger().getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(trigger());

    expect(wrapper().classList.contains('dropdown-open')).toBe(true);
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
});

test('a press outside closes it; a press inside does not', () => {
    renderDropdown();
    fireEvent.click(trigger());

    fireEvent.pointerDown(screen.getByRole('button', { name: 'entry' }));
    expect(wrapper().classList.contains('dropdown-open')).toBe(true);

    fireEvent.pointerDown(screen.getByRole('button', { name: 'outside' }));
    expect(wrapper().classList.contains('dropdown-open')).toBe(false);
    expect(trigger().getAttribute('aria-expanded')).toBe('false');

    // And it opens again afterwards.
    fireEvent.click(trigger());
    expect(wrapper().classList.contains('dropdown-open')).toBe(true);
});

test('focus leaving closes it, and Escape keeps it shut (dropdown-close) until the trigger is activated again', () => {
    renderDropdown();
    fireEvent.focusIn(trigger());
    expect(wrapper().classList.contains('dropdown-open')).toBe(true);

    fireEvent.keyDown(trigger(), { key: 'Escape' });
    expect(wrapper().classList.contains('dropdown-close')).toBe(true);
    expect(wrapper().classList.contains('dropdown-open')).toBe(false);

    fireEvent.click(trigger());
    expect(wrapper().classList.contains('dropdown-open')).toBe(true);

    fireEvent.focusOut(trigger(), { relatedTarget: screen.getByRole('button', { name: 'outside' }) });
    expect(wrapper().classList.contains('dropdown-open')).toBe(false);
});
