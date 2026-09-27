import { render, fireEvent as preactFireEvent } from '@testing-library/preact';
import type { RenderOptions, RenderResult } from '@testing-library/preact';
import type { ComponentChild, ComponentChildren } from 'preact';
import { fireEvent as domFireEvent } from '@testing-library/dom';
import { TranslationProvider } from '@/contexts/TranslationContext';
import { AutovoteProvider } from '@/contexts/AutovoteContext';

// preact/compat rewrites onBlur/onFocus to listen on focusout/focusin
// (which bubble). @testing-library/preact's fireEvent wrapper miscases
// the synthetic event type when falling back to createEvent, so
// fireEvent.focusOut/focusIn never trigger the listener. Route blur/focus
// through @testing-library/dom's focusOut/focusIn so existing tests keep
// using fireEvent.blur/focus naturally.
const fireEvent: typeof preactFireEvent = new Proxy(preactFireEvent, {
    get(target, prop: keyof typeof preactFireEvent) {
        if (prop === 'blur') return domFireEvent.focusOut;
        if (prop === 'focus') return domFireEvent.focusIn;
        return target[prop];
    },
});

/**
 * Wrapper component that provides all necessary context providers.
 * AutovoteProvider mirrors the production tree (App.tsx wraps the modals in
 * it); its mount-time auto-resume no-ops under the mocked window.api.
 */
function AllProviders({ children }: { children?: ComponentChildren }) {
    return (
        <TranslationProvider>
            <AutovoteProvider>{children}</AutovoteProvider>
        </TranslationProvider>
    );
}

/**
 * Custom render function that wraps components with all providers
 * Use this instead of @testing-library/preact render in tests
 *
 * @param ui - Component to render
 * @param options - Render options
 * @returns Render result with all testing-library queries
 */
function customRender(ui: ComponentChild, options?: Omit<RenderOptions, 'wrapper'>): RenderResult {
    return render(ui, { wrapper: AllProviders, ...options });
}

// Re-export everything from testing-library
export * from '@testing-library/preact';

// Override render with our custom render and fireEvent with our patched one
export { customRender as render };
export { fireEvent };

/**
 * Pick an option in a <select>: set its value, then fire the native change
 * event its onChange listens to.
 */
export const pickOption = (select: HTMLSelectElement, value: string) => {
    select.value = value;
    select.dispatchEvent(new window.Event('change', { bubbles: true }));
};
