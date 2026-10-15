/**
 * Shapes of the 1.x settings blob as the frozen load pipeline handles it. Type-only. Everything the file can hold
 * beyond what its container guarantees is `unknown`: the pipeline validates a little, a hand-edited file can hold
 * anything.
 */

/** A sparse map of setting values keyed by setting name. */
export type V1Values = Record<string, unknown>;

/** The `challengeSettings` container: the keys 1.x always carries, and whatever else the file holds. */
interface V1ChallengeSettings {
    globalDefaults: V1Values;
    perChallenge: Record<string, V1Values>;
    titleRules: unknown[];
    titleProfileSuppressions: Record<string, unknown>;
    entryPins: Record<string, unknown>;
    profiles?: unknown;
    seededProfiles?: unknown;
    scenarios?: unknown;
    titlePins?: unknown;
    categoryRules?: unknown;
    [key: string]: unknown;
}

/** The merged, migrated 1.x settings blob. */
export interface V1Blob {
    challengeSettings: V1ChallengeSettings;
    [key: string]: unknown;
}
