/**
 * The translation key for each failure a handler (or the login path behind it) reports, by the exact text or
 * machine code it answers with. Handler wording is English and written for the log, so nothing reaches a user
 * unless it is listed here.
 */
const KNOWN_ERRORS: Record<string, string> = {
    'invalid-args': 'errors.actionInvalidArgs',
    'No authentication token found': 'errors.notLoggedIn',
    'No authentication token found. Please login first.': 'errors.notLoggedIn',
    'not-logged-in': 'errors.notLoggedIn',
    'Invalid credentials': 'errors.invalidCredentials',
    'Login failed. Please check your credentials.': 'errors.invalidCredentials',
    'Turbo not earned — try again later': 'errors.turboNotEarned',
    'No battles to play right now': 'errors.turboNoBattles',
    'A turbo run is already in progress for this challenge': 'errors.turboRunInProgress',
    'Challenge no longer active': 'errors.challengeNoLongerActive',
    'Failed to apply boost': 'errors.boostFailed',
    'Failed to fetch challenges': 'errors.fetchChallengesFailed',
    'Could not list challenges': 'errors.fetchChallengesFailed',
    'Could not read your balance right now': 'errors.fetchChallengesFailed',
    'The account changed while listing challenges': 'errors.accountChanged',
    'account-check-failed': 'errors.accountCheckFailed',
};

/**
 * Display text for an IPC failure's `error`: a failure the app knows becomes its translated what happened / why /
 * what next text; anything else (raw exception text, an unlisted handler message) becomes the generic translated
 * failure text, so no English or technical detail reaches the user. The raw detail goes to the log where the
 * failure is recorded (useAsyncIpcAction). A missing error stays missing.
 *
 * @param t - the translation function (useTranslation().t)
 * @param fallbackKey - the text for a failure the app has no wording for, where the generic one reads wrong
 */
export const ipcErrorText = <E extends string | null | undefined>(
    error: E,
    t: (key: string) => string,
    fallbackKey = 'errors.actionFailed',
) => (error ? t(KNOWN_ERRORS[error] ?? fallbackKey) : error);
