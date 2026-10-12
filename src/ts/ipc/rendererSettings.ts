/**
 * The renderer-facing projection of the settings blob. The auth token and the API headers stay in
 * the main process / settings store; a renderer only learns whether a token exists.
 * Dependency-free (types only) so the Capacitor renderer bundle can import it.
 */

import type { AppSettings, RendererSettings, RendererVisibleSettings } from '../types/settings';

/**
 * Setting keys a renderer may neither read nor write: the token and its derived flag, and the API request headers
 * (which the API client sends under the account's name).
 */
const isRendererHiddenKey = (key: string) => key === 'token' || key === 'hasToken' || key === 'apiHeaders';

/**
 * @param stored - the full settings as loaded from the store; `hasToken` is
 *   derived from its token, never from anything a renderer sent.
 */
const toRendererSettings = (stored: AppSettings): RendererSettings => {
    const visible = Object.fromEntries(
        Object.entries(stored).filter(([key]) => !isRendererHiddenKey(key)),
    ) as RendererVisibleSettings;
    return { ...visible, hasToken: typeof stored.token === 'string' && stored.token !== '' };
};

/**
 * @param payload - a renderer-sent settings object; returns a copy without the
 *   keys a renderer may not write.
 */
const withoutRendererHiddenKeys = (payload: object): Partial<AppSettings> =>
    Object.fromEntries(Object.entries(payload).filter(([key]) => !isRendererHiddenKey(key)));

export { toRendererSettings, isRendererHiddenKey, withoutRendererHiddenKeys };
