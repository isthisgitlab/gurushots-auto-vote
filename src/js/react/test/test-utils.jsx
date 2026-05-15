import { render, fireEvent as preactFireEvent } from '@testing-library/preact';
import { fireEvent as domFireEvent } from '@testing-library/dom';
import { TranslationProvider } from '@/contexts/TranslationContext';

// preact/compat rewrites onBlur/onFocus to listen on focusout/focusin
// (which bubble). @testing-library/preact's fireEvent wrapper miscases
// the synthetic event type when falling back to createEvent, so
// fireEvent.focusOut/focusIn never trigger the listener. Route blur/focus
// through @testing-library/dom's focusOut/focusIn so existing tests keep
// using fireEvent.blur/focus naturally.
const fireEvent = new Proxy(preactFireEvent, {
    get(target, prop) {
        if (prop === 'blur') return domFireEvent.focusOut;
        if (prop === 'focus') return domFireEvent.focusIn;
        return target[prop];
    },
});

/**
 * Wrapper component that provides all necessary context providers
 */
function AllProviders({ children }) {
    return <TranslationProvider>{children}</TranslationProvider>;
}

/**
 * Custom render function that wraps components with all providers
 * Use this instead of @testing-library/preact render in tests
 *
 * @param {React.ReactElement} ui - Component to render
 * @param {object} options - Render options
 * @returns {object} Render result with all testing-library queries
 */
function customRender(ui, options) {
    return render(ui, { wrapper: AllProviders, ...options });
}

// Re-export everything from testing-library
export * from '@testing-library/preact';

// Override render with our custom render and fireEvent with our patched one
export { customRender as render };
export { fireEvent };

// Export providers for cases where custom wrapping is needed
export { AllProviders };
