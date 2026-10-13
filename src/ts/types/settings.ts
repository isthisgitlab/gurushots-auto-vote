/**
 * Shapes of the persisted settings blob (`settings.json` on Electron/CLI, the
 * `gurushots-settings` preference on Android). Type-only: nothing here exists
 * at runtime. Modules pull them in with
 * `import type { AppSettings } from '../types/settings'`.
 *
 * loadSettings (settings/persistence.ts) merges the blob over
 * getDefaultSettings() and validates it: top-level values of the wrong type,
 * challengeSettings containers of the wrong kind, and setting values their
 * schema rejects are dropped for the defaults. So those are typed as the
 * defaults write them. Rules, profiles and scenarios are validated by the
 * modules that read them, so their contents are typed loosely here —
 * `unknown` values the reader narrows.
 */

import type { getUiDefaultSettings } from '../settings/uiDefaults';
import type { SettingKey, SettingValues } from '../settings/schema';

/** A plain object whose values are not trusted yet (hand-edited file, IPC payload). */
export type LooseRecord = { [key: string]: unknown };

/** A sparse map of challenge setting values keyed by SETTINGS_SCHEMA key. */
export type ChallengeValues = Record<string, unknown>;

/**
 * The value a schema-keyed getter returns: the key's schema value type for a
 * known literal key, `unknown` for a key only known at runtime.
 */
export type SettingValueOf<K extends string> = K extends SettingKey ? SettingValues[K] : unknown;

/** A challenge id as callers hold it: the API's string, or a number from older paths. */
export type ChallengeIdInput = string | number | null | undefined;

export interface WindowBounds {
    x?: number;
    y?: number;
    width: number;
    height: number;
}

export type WindowType = 'login' | 'main';

/**
 * One stored challenge rule (`challengeSettings.titleRules[n]`), as
 * sanitizeTitleRule writes it. Inline overrides (TITLE_RULE_INLINE_KEYS) sit on
 * the rule itself, hence the index signature.
 */
export interface TitleRule {
    title?: string;
    titles?: string[];
    match?: string;
    titleMatchModes?: string[];
    challengeTag?: string;
    type?: string;
    pics?: number;
    minHours?: number;
    maxHours?: number;
    /** Strict 'HH:MM': the end time the challenge card shows, in the app timezone, any date. */
    closesAt?: string;
    profile?: string;
    mustIncludeTags?: string[];
    shouldIncludeTags?: string[];
    [key: string]: unknown;
}

/** A challenge (or the id-only stand-in built from the facts cache) that rules match against. */
export interface RuleMatchChallenge {
    id?: string | number;
    title?: unknown;
    tags?: unknown;
    type?: unknown;
    max_photo_submits?: unknown;
    start_time?: unknown;
    close_time?: unknown;
}

/**
 * The rule a value comes from: its title when it has one, and its 1-based place in the rule list
 * (the renderer words an untitled one as "rule #n", in the UI's language). `viaProfile` marks a
 * value the rule's profile supplies rather than one the rule sets itself.
 */
export interface RuleSource {
    title?: string;
    index: number;
    viaProfile?: boolean;
}

/**
 * What a challenge's matching rules contribute, as the renderer reads it (`get-title-profile`):
 * the one profile they apply, whether this challenge suppresses it, the sparse value map with and
 * without the profile layer, and — per key — the rule each value comes from, one map per layer.
 */
export interface TitleRuleInfo {
    profile: { name: string; values: ChallengeValues } | null;
    /** A manually applied profile stands in for the rule's profile. */
    suppressed: boolean;
    /** Every matching rule's inline values and the applied profile's, first match winning. */
    ruleValues: ChallengeValues;
    /** The inline values alone (what still applies with the profile suppressed). */
    inlineValues: ChallengeValues;
    /** Key -> the rule its value comes from in `ruleValues`: the layer that runs while the profile applies. */
    ruleSources: Record<string, RuleSource>;
    /** Key -> the rule that set it in `inlineValues`: the layer that runs once the profile is suppressed. */
    inlineSources: Record<string, RuleSource>;
}

/** The bounded match facts remembered for one active challenge. */
export interface ChallengeFacts {
    tags: string[];
    type?: string;
    max_photo_submits?: number | null;
    start_time?: number | null;
    close_time?: number | null;
}

/** Which Boost or Turbo a pinned photo is for. */
export type EntryPinKind = 'boost' | 'turbo';

/** The photos one challenge pins for Boost and Turbo (entry ids); a missing key is no pin. */
export type EntryPinRecord = { [K in EntryPinKind]?: string };

/** A challenge's pins as read back: the pinned entry id per feature, null = no pin. */
export type EntryPins = Record<EntryPinKind, string | null>;

/** The `challengeSettings` container of the blob. */
export interface ChallengeSettings {
    globalDefaults: ChallengeValues;
    /** Challenge id -> sparse override map. */
    perChallenge: Record<string, ChallengeValues>;
    titleRules: TitleRule[];
    /** Challenge id -> true while a manually applied profile stands in for the title rule's profile. */
    titleProfileSuppressions: Record<string, boolean>;
    /** Challenge id -> the photos pinned for Boost and Turbo (not a schema setting: an image id means nothing in a profile or scenario). */
    entryPins: Record<string, EntryPinRecord>;
    /** Profile display name -> sparse values. */
    profiles?: Record<string, ChallengeValues>;
    /** Normalized names of the intent profiles already seeded once. */
    seededProfiles?: string[];
    /** Scenario name -> stored document (re-validated on every read). */
    scenarios?: Record<string, unknown>;
    /** Challenge id -> first-seen title. */
    titlePins?: Record<string, string>;
    /** Legacy category rules, folded into titleRules by a load-time migration. */
    categoryRules?: unknown[];
}

/** The whole persisted settings blob. */
export interface AppSettings extends ReturnType<typeof getUiDefaultSettings> {
    lastUsername: string;
    mock: boolean;
    token: string;
    onboardingCompleted: boolean;
    windowBounds: Record<WindowType, WindowBounds>;
    challengeSettings: ChallengeSettings;
    apiHeaders: Record<string, string>;
    /** Top-level keys written via setSetting, and the migrations' one-time flags. */
    [key: string]: unknown;
}

/**
 * The settings a renderer sees: the stored blob without its auth token and API headers, plus
 * whether a token exists. Neither the token nor the headers ever leave the main process.
 */
export type RendererSettings = RendererVisibleSettings & { token?: never; apiHeaders?: never; hasToken: boolean };

/** The stored blob without the keys a renderer may not see. */
export type RendererVisibleSettings = {
    [K in keyof AppSettings as K extends 'token' | 'apiHeaders' ? never : K]: AppSettings[K];
};

/** The Android headless-service bridge to the native settings store. */
export interface AndroidHeadlessStore {
    read(): string | null;
    /**
     * Saves the settings blob only if it still holds what `read` last answered, under the lock the app window's plugin
     * takes too. `false` when it did not: the blob changed since that read (read it again and make the change on it),
     * or the native store refused the value. No answer counts as written.
     */
    write(data: string): boolean | void;
    /**
     * Why the latest `write` was refused: `too-large` (past the size the native store takes), `conflict` (the blob
     * changed since the last `read`), `refused` (the store or the commit failed); '' when it was not refused.
     */
    lastWriteRefusal?(): 'too-large' | 'conflict' | 'refused' | '';
    readKey?(key: string): string | null;
    /** `true` when the native side persisted the value. Anything else (`false`, or no answer) is not a write a strict
     *  store takes for one. */
    writeKey?(key: string, data: string): boolean | void;
    /**
     * Saves `data` only if the key still holds what the caller read (`expected`; '' when nothing was stored), under the
     * lock the app window's plugin takes too. `true` only when it was saved.
     */
    compareAndWriteKey?(key: string, expected: string, data: string): boolean;
}
