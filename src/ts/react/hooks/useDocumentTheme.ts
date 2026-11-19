import { useEffect } from 'react';

// The theme the host's effective projection last asked this window to paint, for a Cancel to put back.
let effectiveTheme: string | null = null;

/**
 * Mirror a DaisyUI theme name onto `<html data-theme>`. A falsy theme (e.g. settings not loaded yet) leaves the current
 * attribute alone. `applied` counts every effective projection taken (useEffectiveSettings): the theme is painted again on each,
 * so a theme previewed in the settings form never outlives the projection that is current.
 */
export function useDocumentTheme(theme: string | null | undefined, applied: number) {
    useEffect(() => {
        if (!theme) return undefined;
        effectiveTheme = theme;
        document.documentElement.setAttribute('data-theme', theme);
        // A window that no longer paints it has no theme to put back.
        return () => {
            if (effectiveTheme === theme) effectiveTheme = null;
        };
    }, [theme, applied]);
}

/** The theme this window paints for the installation now (null before one was): what a cancelled preview goes back to. */
export const currentEffectiveTheme = (): string | null => effectiveTheme;
