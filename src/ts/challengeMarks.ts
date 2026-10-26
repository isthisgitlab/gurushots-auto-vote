/**
 * Whether the boundary (challengeIntegrity) marked this challenge: fields that
 * are present but malformed, so every action refuses it.
 *
 * One shared predicate, and a dependency-free leaf on purpose: the renderer
 * imports it on every card render, so anything heavier would ride into every
 * renderer bundle.
 */

const isMarkedChallenge = (challenge: { dataIssues?: string[] } | null | undefined): boolean =>
    Array.isArray(challenge?.dataIssues) && challenge.dataIssues.length > 0;

export { isMarkedChallenge };
