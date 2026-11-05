/**
 * Picks the named fields off an object, as they are on it right now: the real
 * and mock strategies project each endpoint bundle from its shared name list
 * with this (services/votingOrchestrator/context.ts, services/currencyAuto.ts,
 * services/joinChallenges/shared.ts, services/autoClaim.ts).
 */

/**
 * The named endpoints as they are on the client right now.
 */
const pickEndpoints = <C extends object, K extends keyof C>(client: C, names: readonly K[]): Pick<C, K> =>
    Object.fromEntries(names.map((name) => [name, client[name]])) as Pick<C, K>;

export { pickEndpoints };
