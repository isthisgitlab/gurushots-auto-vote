import { render } from '@testing-library/react';
import { TranslationProvider } from '@/contexts/TranslationContext';

/**
 * Wrapper component that provides all necessary context providers
 */
function AllProviders({ children }) {
    return (
        <TranslationProvider>
            {children}
        </TranslationProvider>
    );
}

/**
 * Custom render function that wraps components with all providers
 * Use this instead of @testing-library/react render in tests
 *
 * @param {React.ReactElement} ui - Component to render
 * @param {object} options - Render options
 * @returns {object} Render result with all testing-library queries
 */
function customRender(ui, options) {
    return render(ui, { wrapper: AllProviders, ...options });
}

// Re-export everything from testing-library
export * from '@testing-library/react';

// Override render with our custom render
export { customRender as render };

// Export providers for cases where custom wrapping is needed
export { AllProviders };
