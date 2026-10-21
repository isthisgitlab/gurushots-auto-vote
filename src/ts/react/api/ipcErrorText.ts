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
    'Turbo mode unknown; try again later': 'errors.turboModeUnknown',
    'Snap needs the vision model, which this build does not include; turn on snapYesWithoutModel to play it':
        'errors.snapNeedsModel',
    'Snap is no longer offered for this challenge': 'errors.snapNotOffered',
    'Snap question could not be answered': 'errors.snapUnanswerable',
    'Snap was interrupted; try again later': 'errors.snapInterrupted',
    'Challenge no longer active': 'errors.challengeNoLongerActive',
    'not-enough-slots': 'errors.pickNotEnoughSlots',
    'already-entered': 'errors.pickAlreadyEntered',
    'submit-rejected': 'errors.pickRejected',
    'submit-unclear': 'errors.pickUnclear',
    'submit-busy': 'errors.pickBusy',
    'pin-cap-reached': 'errors.pinCapReached',
    'pin-write-failed': 'errors.pinFailed',
    'library-read-failed': 'errors.libraryReadFailed',
    'Failed to apply boost': 'errors.boostFailed',
    'Failed to fetch challenges': 'errors.fetchChallengesFailed',
    'Could not list challenges': 'errors.fetchChallengesFailed',
    'Could not read your balance right now': 'errors.fetchChallengesFailed',
    'The account changed while listing challenges': 'errors.accountChanged',
    'account-changed': 'errors.accountChanged',
    'account-check-failed': 'errors.accountCheckFailed',
    'token-not-saved': 'errors.tokenNotSaved',
    'web-shell-token': 'errors.webShellToken',
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
) => (error ? t(Object.hasOwn(KNOWN_ERRORS, error) ? KNOWN_ERRORS[error] : fallbackKey) : error);

/** The translation key for each code the photo suggestions (Pick… > Auto) answer with. */
const SUGGEST_ERRORS: Record<string, string> = {
    'no-chosen-entered': 'errors.suggestNoChosenEntered',
    'no-chosen-unusable': 'errors.suggestNoChosenUnusable',
    'no-match': 'errors.suggestNoMatch',
    'no-eligible': 'errors.suggestNoEligible',
    'no-more-suggestions': 'errors.suggestNoMore',
    'suggest-busy': 'errors.suggestBusy',
    'account-changed': 'errors.suggestAccountChanged',
    'challenge-ended': 'errors.suggestChallengeEnded',
};

/**
 * Display text for a failed photo suggestion: its own codes get their own wording, a failure every action can
 * have (not logged in, invalid arguments) its usual text, and anything else (`fetch-failed`, `suggest-failed`)
 * says the ranking failed. A missing error stays missing.
 */
export const suggestErrorText = <E extends string | null | undefined>(error: E, t: (key: string) => string) =>
    error && Object.hasOwn(SUGGEST_ERRORS, error)
        ? t(SUGGEST_ERRORS[error])
        : ipcErrorText(error, t, 'errors.suggestFailed');
