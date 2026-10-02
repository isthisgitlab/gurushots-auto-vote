import type { z } from 'zod';

/**
 * Shape of a single SETTINGS_SCHEMA entry. All fields are optional so the
 * heterogeneous entries (some carry contextValidation/getContextError, most
 * don't) all fit one type; the typed validator signatures also give the
 * inline `(value) => ...` callbacks contextual typing so they aren't flagged
 * as implicit-any.
 */
export interface SettingsSchemaEntry {
    type?: string;
    default?: unknown;
    perChallenge?: boolean;
    /**
     * Only settable on a challenge or a profile: the key
     * has NO global value. Hidden from the global settings modal, refused by
     * setGlobalDefault, and a stored global value is ignored — the schema default applies
     * until a challenge override or profile sets it. Implies `perChallenge`. Used for the
     * settings that require an explicit per-challenge or per-profile choice.
     */
    challengeOnly?: boolean;
    validation: z.ZodType;
    contextValidation?: (
        value: unknown,
        allSettings: Record<string, unknown>,
        challengeId?: string | number | null,
    ) => boolean;
    getContextError?: (
        value: unknown,
        allSettings: Record<string, unknown>,
        challengeId?: string | number | null,
    ) => string;
    dependsOn?: string[];
    validationOrder?: number;
    group?: string;
    label: string;
    description: string;
    /**
     * Translation key for an optional deeper "explain this"
     * disclosure shown beside the row (e.g. the two distinct meanings of a `0` sentinel).
     * Display-only, like `description` — never affects validation. Forwarded by the schema
     * IPC projection alongside `description`.
     */
    helpKey?: string;
    /**
     * Advertised lower bound, mirroring `validation`. Forwarded to the
     * renderer by the schema IPC projection and bound to the number input.
     * Without min/max/unit a number input renders unbounded and unlabelled,
     * and the only feedback for an out-of-range value is a generic "could not
     * be saved" banner; keep them in step with the zod validator.
     */
    min?: number;
    /** Advertised upper bound, mirroring `validation`. */
    max?: number;
    /** Translation key for the suffix shown beside a number input. */
    unit?: string;
}
