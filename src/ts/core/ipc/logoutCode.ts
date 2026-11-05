/**
 * What a refused logout is called wherever it travels (the error a shell throws, the answer the web server gives): the
 * settings did not take the sign-out, so the user is still logged in. Dependency-free, so the renderer can share it.
 */
export const LOGOUT_NOT_SAVED = 'logout-not-saved';
