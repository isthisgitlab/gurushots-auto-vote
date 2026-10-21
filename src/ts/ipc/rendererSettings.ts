/**
 * The renderer-facing projection of the configuration. The `auth` block (the token, the API headers, the last user
 * name) stays in the main process / settings store; a renderer only learns whether a token exists. Dependency-free
 * (types only) so the Capacitor renderer bundle can import it.
 */

import type { ConfigApp, ConfigV2 } from '../types/config';
import type { RendererSettings } from '../types/settings';

/**
 * Setting keys a renderer may neither read nor write: the sign-in block, the token and its derived flag, and the API
 * request headers (which the API client sends under the account's name).
 */
const isRendererHiddenKey = (key: string) =>
    key === 'auth' || key === 'token' || key === 'hasToken' || key === 'apiHeaders';

/**
 * Sign-in keys a renderer may read one at a time but never write: the login form pre-fills the last user name.
 * It is written by the main process alone.
 */
const isRendererReadOnlyKey = (key: string) => key === 'lastUsername';

/**
 * @param stored - the full configuration as loaded from the store; `hasToken` is
 *   derived from its token, never from anything a renderer sent.
 */
const toRendererSettings = (stored: ConfigV2): RendererSettings => {
    const { auth, ...visible } = stored;
    return { ...visible, hasToken: typeof auth.token === 'string' && auth.token !== '' };
};

/**
 * @param payload - a renderer-sent settings object (flat `app` keys); returns a copy without the
 *   keys a renderer may not write.
 */
const withoutRendererHiddenKeys = (payload: object): Partial<ConfigApp> =>
    Object.fromEntries(
        Object.entries(payload).filter(([key]) => !isRendererHiddenKey(key) && !isRendererReadOnlyKey(key)),
    );

export { toRendererSettings, isRendererHiddenKey, isRendererReadOnlyKey, withoutRendererHiddenKeys };
