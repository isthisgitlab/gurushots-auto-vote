/**
 * Shapes of the configuration (`config.json`, `version: 2`). Type-only: nothing here exists at runtime. The importer
 * (settings/importV1) produces a `StoredConfigV2` from a `settings.json` (settings format 1); loading it
 * (settings/persistence.ts) validates it and fills what it lacks, which makes the `ConfigV2` the whole app reads and
 * writes.
 *
 * Setting values are stored as the settings facade validates them on read; here they are `unknown` because the
 * file is hand-editable and nothing is validated until it is read.
 */

import type { getUiDefaultSettings } from '../settings/uiDefaults';
import type { TitleRule, WindowBounds, WindowType } from './settings';

/** A sparse map of setting values keyed by setting name. */
type SettingValuesV2 = Record<string, unknown>;

/** The sign-in state, for the main process only; a renderer never sees it. */
export interface ConfigAuthV2 {
    token: string;
    apiHeaders: Record<string, string>;
    lastUsername: string;
}

/** The photos one challenge pins for Boost and Turbo (entry ids); a missing key is no pin. */
export interface ChallengePinsV2 {
    boost?: string;
    turbo?: string;
}

/**
 * Everything stored for one challenge id. A field is present only when `settings.json` held something for the id: `values` iff
 * it had a per-challenge entry (an empty `{}` included), `suppressRuleProfile` iff its rule profile was suppressed,
 * `pins` iff it had a pin record.
 */
export interface ChallengeRecordV2 {
    values?: SettingValuesV2;
    suppressRuleProfile?: true;
    pins?: ChallengePinsV2;
}

/** Where a reference that cannot be resolved is stored: the one that holds it, named the way the settings show it. */
export type ImportRefHolder =
    /** a challenge rule: `number` counts from 1 in the stored order, `title` is its (shortened) title match text */
    | { kind: 'rule'; number: number; title?: string }
    /** a saved profile */
    | { kind: 'profile'; name: string }
    /** a challenge's own settings: its id, and its title where the import knew it */
    | { kind: 'challenge'; id: string; title?: string };

/**
 * One reference the import found that does not apply, as the user knows its parts (never a value other than the name a
 * reference points at): `holder` refers to the `profile` or `scenario` called `name`. `invalid`: it exists, but the
 * settings reject it as it is stored; without it, it does not exist.
 */
export interface ImportRef {
    holder: ImportRefHolder;
    refers: 'profile' | 'scenario';
    name: string;
    invalid?: true;
}

/**
 * What the import found that it could not resolve. A report an earlier build stored lists plain strings (key paths such
 * as `rules[2].profile: "Night owl"`), which are shown as they are.
 */
export interface ImportReportV2 {
    refsBlocked: Array<string | ImportRef>;
}

/**
 * App preferences: language, theme, timezone, check frequency, window bounds, UI flags, and the app-state flags with
 * no settings section (`autovoteRunning`, `skipUpdateVersion`, ...). A load fills every key below; any other key a
 * file holds is kept as it is.
 */
export interface ConfigApp extends ReturnType<typeof getUiDefaultSettings> {
    mock: boolean;
    onboardingCompleted: boolean;
    windowBounds: Record<WindowType, WindowBounds>;
    [key: string]: unknown;
}

/** The record of the import of the first `settings.json`. */
export interface ImportedV2 {
    at: string;
    report: ImportReportV2;
    acknowledged: boolean;
}

/** The configuration document, over the shape of its `app` block and of a rule. */
interface ConfigDocument<App, Rule> {
    version: 2;
    imported?: ImportedV2;
    app: App;
    auth: ConfigAuthV2;
    /** The global defaults of the per-challenge settings. */
    defaults: SettingValuesV2;
    /** Named setting sets. A value that is not an object is kept as stored (it is unusable, as it was before the import). */
    profiles: Record<string, unknown>;
    /** Normalized names of the intent profiles already seeded once. */
    seededProfiles: string[];
    /** Scenario name to stored scenario document (validated when read). */
    scenarios: Record<string, unknown>;
    /** The challenge rules in precedence order, as stored; an entry that is not an object is kept (it matches nothing). */
    rules: Rule[];
    /** Challenge id to what is stored for it. */
    challenges: Record<string, ChallengeRecordV2>;
}

/** The whole configuration, loaded: validated, with every container and every `app` key present. */
export type ConfigV2 = ConfigDocument<ConfigApp, TitleRule>;

/** A configuration as a file holds it, or as the importer writes it: `app` lacks the keys a load fills. */
export type StoredConfigV2 = ConfigDocument<Record<string, unknown>, unknown>;
