/**
 * Shapes of the 2.x configuration (`config.json`, `version: 2`). Type-only: nothing here exists at runtime. The 1.x
 * importer (settings/importV1) produces a `ConfigV2` from a 1.x `settings.json`.
 *
 * Setting values are stored as the settings facade validates them on read; here they are `unknown` because the
 * file is hand-editable and nothing is validated until it is read.
 */

/** A sparse map of setting values keyed by setting name. */
type SettingValuesV2 = Record<string, unknown>;

/** The sign-in state, for the main process only; a renderer never sees it. */
interface ConfigAuthV2 {
    token: string;
    apiHeaders: Record<string, string>;
    lastUsername: string;
    chosenPhotosMemberId: string;
}

/** The photos one challenge pins for Boost and Turbo (entry ids); a missing key is no pin. */
export interface ChallengePinsV2 {
    boost?: string;
    turbo?: string;
}

/**
 * Everything stored for one challenge id. A field is present only when 1.x held something for the id: `values` iff
 * it had a per-challenge entry (an empty `{}` included), `suppressRuleProfile` iff its rule profile was suppressed,
 * `pins` iff it had a pin record.
 */
export interface ChallengeRecordV2 {
    values?: SettingValuesV2;
    suppressRuleProfile?: true;
    pins?: ChallengePinsV2;
}

/**
 * What the 1.x import found that it could not resolve. Key paths and names only, never values other than the name
 * a reference points at. Each entry reads `<path>: <the unresolved name as a JSON string>`, for example
 * `rules[2].profile: "Night owl"`, `profiles["Night"].scenario: "Plan B"`, `defaults.scenario: "Plan B"` or
 * `challenges.123.values.scenario: "Plan B"`: rule indexes count from 0 in the stored order, profile names are
 * JSON-quoted in brackets, a challenge id is bracketed and JSON-quoted too when it is not made of letters, digits,
 * `_` and `-`.
 */
export interface ImportReportV2 {
    refsBlocked: string[];
}

/** The record of the one-time 1.x import. */
interface ImportedV2 {
    at: string;
    sha256: string;
    report: ImportReportV2;
    acknowledged: boolean;
}

/** The whole configuration document. */
export interface ConfigV2 {
    version: 2;
    imported?: ImportedV2;
    /** App preferences: language, theme, timezone, check frequency, window bounds, UI flags. */
    app: Record<string, unknown>;
    auth: ConfigAuthV2;
    /** The global defaults of the per-challenge settings. */
    defaults: SettingValuesV2;
    /** Named setting sets. A value that is not an object is kept as stored (it is unusable, as in 1.x). */
    profiles: Record<string, unknown>;
    /** Normalized names of the intent profiles already seeded once. */
    seededProfiles: string[];
    /** Scenario name to stored scenario document (validated when read). */
    scenarios: Record<string, unknown>;
    /** The challenge rules in precedence order, as stored; an entry that is not an object is kept (it matches nothing). */
    rules: unknown[];
    /** Challenge id to what is stored for it. */
    challenges: Record<string, ChallengeRecordV2>;
}
