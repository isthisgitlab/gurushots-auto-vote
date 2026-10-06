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

/** The bounded match facts remembered for one active challenge. */
export interface ChallengeFacts {
    tags: string[];
    type?: string;
    max_photo_submits?: number | null;
    start_time?: number | null;
    close_time?: number | null;
}

/** The `challengeSettings` container of the blob. */
export interface ChallengeSettings {
    globalDefaults: ChallengeValues;
    /** Challenge id -> sparse override map. */
    perChallenge: Record<string, ChallengeValues>;
    titleRules: TitleRule[];
    /** Challenge id -> true while a manually applied profile stands in for the title rule's profile. */
    titleProfileSuppressions: Record<string, boolean>;
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
 * The settings a renderer sees: the stored blob without its auth token, plus
 * whether one exists. The token itself never leaves the main process.
 */
export type RendererSettings = {
    [K in keyof AppSettings as K extends 'token' ? never : K]: AppSettings[K];
} & { token?: never; hasToken: boolean };

/** The Android headless-service bridge to the native settings store. */
export interface AndroidHeadlessStore {
    read(): string | null;
    write(data: string): void;
    readKey?(key: string): string | null;
    writeKey?(key: string, data: string): void;
}
