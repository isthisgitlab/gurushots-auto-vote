/**
 * The renderer-facing projection of the settings blob. The auth token stays in
 * the main process / settings store; a renderer only learns whether one exists.
 * Dependency-free (types only) so the Capacitor renderer bundle can import it.
 */

import type { AppSettings, RendererSettings } from '../types/settings';

/** Setting keys a renderer may neither read nor write: the token and its derived flag. */
const isRendererHiddenKey = (key: string) => key === 'token' || key === 'hasToken';

/**
 * @param stored - the full settings as loaded from the store; `hasToken` is
 *   derived from its token, never from anything a renderer sent.
 */
const toRendererSettings = (stored: AppSettings): RendererSettings => {
    const { token, ...rest } = stored;
    return { ...rest, hasToken: typeof token === 'string' && token !== '' };
};

/**
 * @param payload - a renderer-sent settings object; returns a copy without the
 *   keys a renderer may not write.
 */
const withoutRendererHiddenKeys = (payload: object): Partial<AppSettings> =>
    Object.fromEntries(Object.entries(payload).filter(([key]) => !isRendererHiddenKey(key)));

export { toRendererSettings, isRendererHiddenKey, withoutRendererHiddenKeys };
