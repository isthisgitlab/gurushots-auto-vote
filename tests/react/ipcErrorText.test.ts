import { ipcErrorText, joinRefusalText, suggestErrorText } from '@/api/ipcErrorText';

const t = (key: string) => `[${key}]`;

describe('ipcErrorText', () => {
    test.each([
        ['invalid-args', 'errors.actionInvalidArgs'],
        ['No authentication token found', 'errors.notLoggedIn'],
        ['No authentication token found. Please login first.', 'errors.notLoggedIn'],
        ['not-logged-in', 'errors.notLoggedIn'],
        ['Invalid credentials', 'errors.invalidCredentials'],
        ['Login failed. Please check your credentials.', 'errors.invalidCredentials'],
        ['Turbo not earned — try again later', 'errors.turboNotEarned'],
        ['No battles to play right now', 'errors.turboNoBattles'],
        ['A turbo run is already in progress for this challenge', 'errors.turboRunInProgress'],
        ['Turbo mode unknown; try again later', 'errors.turboModeUnknown'],
        [
            'Snap needs the vision model, which this build does not include; turn on snapYesWithoutModel to play it',
            'errors.snapNeedsModel',
        ],
        ['Snap is no longer offered for this challenge', 'errors.snapNotOffered'],
        ['Snap question could not be answered', 'errors.snapUnanswerable'],
        ['Snap was interrupted; try again later', 'errors.snapInterrupted'],
        ['Challenge no longer active', 'errors.challengeNoLongerActive'],
        ['challenge-data-incomplete', 'errors.challengeDataIncomplete'],
        ['challenge data cannot be read', 'errors.challengeDataIncomplete'],
        ['pin-cap-reached', 'errors.pinCapReached'],
        ['pin-write-failed', 'errors.pinFailed'],
        ['library-read-failed', 'errors.libraryReadFailed'],
        ['Failed to apply boost', 'errors.boostFailed'],
        ['Failed to fetch challenges', 'errors.fetchChallengesFailed'],
        ['Could not list challenges', 'errors.fetchChallengesFailed'],
        ['Could not read your balance right now', 'errors.fetchChallengesFailed'],
        ['token-not-saved', 'errors.tokenNotSaved'],
        ['web-shell-token', 'errors.webShellToken'],
        ['superseded', 'errors.superseded'],
    ])('words the known failure %j as %s', (error, key) => {
        expect(ipcErrorText(error, t)).toBe(`[${key}]`);
    });

    test('anything else — raw exception text, an unlisted handler message, a fallback code — is the generic failure', () => {
        for (const error of ['ECONNRESET at socket.js:12', 'action-failed', 'action-error', 'Boost failed']) {
            expect(ipcErrorText(error, t)).toBe('[errors.actionFailed]');
        }
    });

    test('a name every object inherits is not a known failure', () => {
        for (const error of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
            expect(ipcErrorText(error, t)).toBe('[errors.actionFailed]');
            expect(ipcErrorText(error, t, 'errors.pinFailed')).toBe('[errors.pinFailed]');
        }
    });

    test('a surface with a better generic text names it', () => {
        expect(ipcErrorText('Bad credentials', t, 'errors.loginFailed')).toBe('[errors.loginFailed]');
        // A known failure still gets its own text there.
        expect(ipcErrorText('Invalid credentials', t, 'errors.loginFailed')).toBe('[errors.invalidCredentials]');
    });

    test('a missing error stays missing', () => {
        expect(ipcErrorText(null, t)).toBeNull();
        expect(ipcErrorText(undefined, t)).toBeUndefined();
        expect(ipcErrorText('', t)).toBe('');
    });
});

describe('joinRefusalText', () => {
    test.each([
        ['full', 'errors.joinRefusedFull'],
        ['price-unknown', 'errors.joinRefusedPriceUnknown'],
    ])('words the %j refusal as %s', (reason, key) => {
        expect(joinRefusalText(reason, t)).toBe(`[${key}]`);
    });

    test('any other reason, and a missing one, stays missing: the status has its own text', () => {
        for (const reason of ['no-photo', 'unconfirmed', 'already-joined']) {
            expect(joinRefusalText(reason, t)).toBeNull();
        }
        expect(joinRefusalText(undefined, t)).toBeNull();
        expect(joinRefusalText('', t)).toBeNull();
    });

    test('the refusal reasons are not error wording: ipcErrorText stays generic on them', () => {
        expect(ipcErrorText('full', t)).toBe('[errors.actionFailed]');
        expect(ipcErrorText('price-unknown', t)).toBe('[errors.actionFailed]');
    });
});

describe('suggestErrorText', () => {
    test.each([
        ['no-chosen-entered', 'errors.suggestNoChosenEntered'],
        ['no-chosen-unusable', 'errors.suggestNoChosenUnusable'],
        ['no-match', 'errors.suggestNoMatch'],
        ['no-eligible', 'errors.suggestNoEligible'],
        ['suggest-busy', 'errors.suggestBusy'],
        ['challenge-ended', 'errors.suggestChallengeEnded'],
        ['invalid-args', 'errors.actionInvalidArgs'],
        ['not-logged-in', 'errors.notLoggedIn'],
        ['fetch-failed', 'errors.suggestFailed'],
        ['suggest-failed', 'errors.suggestFailed'],
        ['ECONNRESET at socket.js:12', 'errors.suggestFailed'],
        ['constructor', 'errors.suggestFailed'],
    ])('words %j as %s', (error, key) => {
        expect(suggestErrorText(error, t)).toBe(`[${key}]`);
    });

    test('a missing error stays missing', () => {
        expect(suggestErrorText(null, t)).toBeNull();
        expect(suggestErrorText(undefined, t)).toBeUndefined();
        expect(suggestErrorText('', t)).toBe('');
    });
});
