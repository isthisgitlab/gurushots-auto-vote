import { useEffect } from 'react';

/**
 * Mirror a DaisyUI theme name onto `<html data-theme>`. A falsy theme (e.g.
 * settings not loaded yet) leaves the current attribute alone.
 *
 * @param {string | null | undefined} theme
 */
export function useDocumentTheme(theme) {
    useEffect(() => {
        if (theme) {
            document.documentElement.setAttribute('data-theme', theme);
        }
    }, [theme]);
}
