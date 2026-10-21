/**
 * useFocusRestore — a recorded trigger that leaves the page hands focus to the fallback only while
 * focus is lost; focus the user moved anywhere else, and focus already on `body` with nothing
 * recorded, is never moved.
 */

import { useRef } from 'react';
import { act, render } from '@testing-library/preact';
import { fireEvent } from './helpers/test-utils';
import { useFocusRestore } from '@/hooks/useFocusRestore';

/**
 * The fallback target plus two pressable triggers in one tree: `trigger` can unmount, `other`
 * stays and doubles as the place focus can move to — and as a second recordable press.
 */
const Probe = ({ withTrigger, withFallback }: { withTrigger?: boolean; withFallback?: boolean }) => {
    const fallbackRef = useRef<HTMLDivElement | null>(null);
    const record = useFocusRestore(() => fallbackRef.current);
    return (
        <div>
            {withFallback !== false && <div ref={fallbackRef} data-testid="fallback" tabIndex={-1} />}
            {withTrigger !== false && (
                <button type="button" data-testid="trigger" onClick={(event) => record(event.currentTarget)} />
            )}
            <button type="button" data-testid="other" onClick={(event) => record(event.currentTarget)} />
        </div>
    );
};

const setUp = () => {
    const view = render(<Probe />);
    return {
        view,
        trigger: view.getByTestId('trigger'),
        other: view.getByTestId('other'),
        fallback: view.getByTestId('fallback'),
    };
};

// Lets a focusout's deferred check run before the next statement.
const flushMicrotasks = () => act(async () => undefined);

// A native focusout: it bubbles, so the hook's document-level listener hears it (RTL's synthetic
// focusout does not bubble).
const focusOut = (element: HTMLElement) => {
    element.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
};

test('focus on body with no recorded trigger moves nothing', () => {
    const { view, fallback } = setUp();
    const focus = jest.spyOn(fallback, 'focus');
    // A focusout and a focusin with no record say nothing either.
    focusOut(fallback);
    fireEvent.focus(fallback);
    expect(document.activeElement).toBe(document.body);
    view.rerender(<Probe withTrigger={false} />);
    view.rerender(<Probe />);
    expect(document.activeElement).toBe(document.body);
    expect(focus).not.toHaveBeenCalled();
});

test('a recorded trigger that unmounts while focus is lost moves focus to the fallback, without scrolling', () => {
    const { view, trigger, other, fallback } = setUp();
    const focus = jest.spyOn(fallback, 'focus');
    trigger.focus();
    fireEvent.click(trigger);
    expect(document.activeElement).toBe(trigger);
    view.rerender(<Probe withTrigger={false} />);
    expect(document.activeElement).toBe(fallback);
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    // The record is spent: a later render does not hand focus around again.
    other.focus();
    view.rerender(<Probe withTrigger={false} />);
    expect(document.activeElement).toBe(other);
});

test('focus the user moved elsewhere before the trigger unmounts is not taken', async () => {
    const { view, trigger, other, fallback } = setUp();
    const focus = jest.spyOn(fallback, 'focus');
    trigger.focus();
    fireEvent.click(trigger);
    other.focus();
    await flushMicrotasks();
    view.rerender(<Probe withTrigger={false} />);
    expect(document.activeElement).toBe(other);
    expect(focus).not.toHaveBeenCalled();
});

test('a press that left focus elsewhere records nothing (engines that do not focus a button on click)', () => {
    const { view, trigger, other, fallback } = setUp();
    const focus = jest.spyOn(fallback, 'focus');
    other.focus();
    fireEvent.click(trigger);
    view.rerender(<Probe withTrigger={false} />);
    expect(document.activeElement).toBe(other);
    expect(focus).not.toHaveBeenCalled();
});

test('focus that moved to body (nothing took it) forgets the record, so the unmount acts on nothing', async () => {
    const { view, trigger, fallback } = setUp();
    const focus = jest.spyOn(fallback, 'focus');
    trigger.focus();
    fireEvent.click(trigger);
    trigger.blur();
    await flushMicrotasks();
    view.rerender(<Probe withTrigger={false} />);
    expect(document.activeElement).toBe(document.body);
    expect(focus).not.toHaveBeenCalled();
});

test('the record survives a focusout that leaves the button focused (the window lost focus)', async () => {
    const { view, trigger, fallback } = setUp();
    const focus = jest.spyOn(fallback, 'focus');
    trigger.focus();
    fireEvent.click(trigger);
    // A focusout that is not a focus move: the active element is still the button.
    focusOut(trigger);
    await flushMicrotasks();
    view.rerender(<Probe withTrigger={false} />);
    expect(document.activeElement).toBe(fallback);
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
});

test('another element’s focusout is not the record to forget, and a focusin on the button keeps it', async () => {
    const { view, trigger, fallback } = setUp();
    trigger.focus();
    fireEvent.click(trigger);
    focusOut(view.getByTestId('fallback'));
    fireEvent.focus(trigger);
    await flushMicrotasks();
    view.rerender(<Probe withTrigger={false} />);
    expect(document.activeElement).toBe(fallback);
});

test('a record superseded in the same task is not the deferred check’s to wipe', async () => {
    const { view, trigger, fallback } = setUp();
    const focus = jest.spyOn(fallback, 'focus');
    trigger.focus();
    fireEvent.click(trigger);
    trigger.blur(); // queues the deferred check for the trigger's record
    fireEvent.click(view.getByTestId('other')); // the script race: focus is on body, so this records nothing
    await flushMicrotasks();
    view.rerender(<Probe withTrigger={false} />);
    expect(document.activeElement).toBe(document.body);
    expect(focus).not.toHaveBeenCalled();
});

test('a removal’s own focusout does not read as the user moving focus', async () => {
    const { view, trigger, fallback } = setUp();
    trigger.focus();
    fireEvent.click(trigger);
    // Some engines fire a focusout when the focused button is removed; held back here, it runs
    // only after the button is already gone — the record must survive it, so the layout effect
    // can still restore.
    const queued: Array<() => void> = [];
    const queue = jest.spyOn(globalThis, 'queueMicrotask').mockImplementation((callback) => {
        queued.push(callback);
    });
    focusOut(trigger);
    trigger.remove();
    queue.mockRestore();
    queued.forEach((callback) => callback());
    view.rerender(<Probe withTrigger={false} />);
    expect(document.activeElement).toBe(fallback);
});

test('a recorded trigger still on the page acts on nothing', () => {
    const { view, trigger, fallback } = setUp();
    const focus = jest.spyOn(fallback, 'focus');
    trigger.focus();
    fireEvent.click(trigger);
    view.rerender(<Probe withFallback={false} />);
    expect(document.activeElement).toBe(trigger);
    expect(focus).not.toHaveBeenCalled();
});

test('focus counts as lost when there is no active element at all', () => {
    const { view, trigger, fallback } = setUp();
    trigger.focus();
    fireEvent.click(trigger);
    const active = jest.spyOn(document, 'activeElement', 'get').mockReturnValue(null);
    view.rerender(<Probe withTrigger={false} />);
    active.mockRestore();
    expect(document.activeElement).toBe(fallback);
});

test('focus on an element the page has dropped counts as lost too', () => {
    const { view, trigger, fallback } = setUp();
    trigger.focus();
    fireEvent.click(trigger);
    const active = jest.spyOn(document, 'activeElement', 'get').mockReturnValue(document.createElement('div'));
    view.rerender(<Probe withTrigger={false} />);
    active.mockRestore();
    expect(document.activeElement).toBe(fallback);
});

test('a fallback that is not there is skipped', () => {
    const { view, trigger } = setUp();
    trigger.focus();
    fireEvent.click(trigger);
    view.rerender(<Probe withTrigger={false} withFallback={false} />);
    expect(document.activeElement).toBe(document.body);
});
