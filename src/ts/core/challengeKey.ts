/**
 * Reject the three keys that address Object.prototype instead of creating an own
 * property. Challenge ids are numeric in practice, so this never fires today — but
 * the id is remote-controlled and every write path here uses it as a bracket key.
 */
const isUnsafeChallengeKey = (challengeId: string | number): boolean =>
    challengeId === '__proto__' || challengeId === 'constructor' || challengeId === 'prototype';

export { isUnsafeChallengeKey };
