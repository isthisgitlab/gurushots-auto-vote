import { useEffect } from 'react';

/**
 * Mirror a DaisyUI theme name onto `<html data-theme>`. A falsy theme (e.g.
 * settings not loaded yet) leaves the current attribute alone.
 */
export function useDocumentTheme(theme: string | null | undefined) {
    useEffect(() => {
        if (theme) {
            document.documentElement.setAttribute('data-theme', theme);
        }
    }, [theme]);
}
