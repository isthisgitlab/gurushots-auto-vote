/**
 * Setting-shaped types shared by the settings modules and the renderer. Type-only: nothing here exists at runtime. The
 * shape of the persisted configuration itself is in ./config.
 *
 * loadSettings (settings/persistence.ts) validates the stored configuration: `app` and `auth` values of the wrong
 * type, containers of the wrong kind, and setting values their schema rejects are dropped for the defaults, so those
 * are typed as the defaults write them. Rules, profiles and scenarios are validated by the modules that read them, so
 * their contents are typed loosely — `unknown` values the reader narrows.
 */

import type { SettingKey, SettingValues } from '../settings/schema';
import type { ConfigAuthV2, ConfigV2 } from './config';

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
    /** Strict 'HH:MM': the end time the challenge card shows, in the app timezone, any date. With `closesAtTimes`, the first of them. */
    closesAt?: string;
    /** Every end time a rule closing at any one of matches, written only when there are two or more; `closesAt` is the first. */
    closesAtTimes?: string[];
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

/**
 * What `setEntryPin` did: `ok`; `invalid` (an argument was refused); `cap` (a new challenge over the pin cap);
 * `write-failed` (the settings file could not be written).
 */
export type EntryPinResult = 'ok' | 'invalid' | 'cap' | 'write-failed';

/** A challenge's pins as read back: the pinned entry id per feature, null = no pin. */
export type EntryPins = Record<EntryPinKind, string | null>;

/** The sign-in keys of the configuration: the only keys of `auth`, addressed by name through getSetting / setSetting. */
export type AuthKey = keyof ConfigAuthV2;

/**
 * The settings a renderer sees: the configuration without its `auth` block (the token, the API headers, the last
 * user name and the chosen-photos account never leave the main process), plus whether a token exists.
 */
export type RendererSettings = Omit<ConfigV2, 'auth'> & { hasToken: boolean };

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
