/** Settings of the `autoFill` group (labelled "Auto-Submit" in the UI). */

import { z } from 'zod';
import { isInteger } from '../../numbers';
import { isPlainObject } from '../../plainObject';
import { CHOSEN_PHOTO_ID_RE, MAX_CHOSEN_PHOTOS, MAX_TAG_LENGTH } from '../limits';
import { MAX_SCHEDULE_SECONDS, nonNegNumber, zBool } from './validators';
import type { SettingsSchemaEntry } from './entry';

// Auto-fill schedule: rows of { count, seconds } meaning "have ≥ count entries
// once ≤ seconds remain before close". Counts are 2–4: entry 1 always exists
// (joining a challenge IS submitting a photo — there is no separate join
// flow), and GuruShots challenges allow at most 4 images, so the schedule is
// at most three rows (images 2, 3, 4). Counts must be unique (each target
// needs exactly one threshold); row order is irrelevant at runtime (the
// trigger is max-based) and the runtime additionally clamps to the live
// max_photo_submits as a safety net. The seconds cap is defense-in-depth
// against a corrupted settings file or out-of-band write, same rationale as
// the tagsList caps below.
const MAX_SCHEDULE_ROWS = 3;
// Mirrored in services/scheduleRemap.ts (renderer-bundle-safe module that
// can't import this zod-carrying file) — change both together.
const MAX_SCHEDULE_COUNT = 4;
const fillScheduleRow = z
    .object({
        count: z.number().int().min(2).max(MAX_SCHEDULE_COUNT),
        seconds: z.number().int().min(0).max(MAX_SCHEDULE_SECONDS),
    })
    .strict();
const fillSchedule = z
    .array(fillScheduleRow)
    .max(MAX_SCHEDULE_ROWS)
    .refine((rows) => new Set(rows.map((r) => r.count)).size === rows.length);

/**
 * Clamp a persisted autoFillSchedule array to the current bounds. Used by the
 * load-time `_autoFillScheduleBoundsV1` sanitizer in settings/migrations/autoFillSchedule.ts: the Settings
 * modal resubmits EVERY persisted key on save, so a stored schedule that
 * violates the (tightened) validator would block saving unrelated settings
 * until repaired — this heals such data on load instead. Keeps only strict
 * { count, seconds } rows within bounds, dedupes by count (first wins), and
 * sorts by count. Returns the sanitized array when anything changed, or null
 * when the input already conforms or isn't an array at all (load-time
 * validation drops a non-array value).
 */
export const sanitizeFillSchedule = (value: unknown): Array<{ count: number; seconds: number }> | null => {
    if (!Array.isArray(value)) return null;
    const seen: Set<number> = new Set();
    const normalized = value
        .filter((row): row is { count: number; seconds: number } => {
            if (!isPlainObject(row)) return false;
            const { count, seconds } = row;
            if (!isInteger(count) || count < 2 || count > MAX_SCHEDULE_COUNT) return false;
            if (!isInteger(seconds) || seconds < 0 || seconds > MAX_SCHEDULE_SECONDS) return false;
            if (seen.has(count)) return false;
            seen.add(count);
            return true;
        })
        .sort((a, b) => a.count - b.count)
        .map((row) => ({ count: row.count, seconds: row.seconds }));
    const unchanged =
        normalized.length === value.length &&
        normalized.every((row, i) => {
            const orig = value[i];
            return (
                isPlainObject(orig) &&
                orig.count === row.count &&
                orig.seconds === row.seconds &&
                Object.keys(orig).length === 2
            );
        });
    return unchanged ? null : normalized;
};

// Per-string and total-array caps for tag-list settings. A typical use is
// a few words per tag, a handful of tags per challenge — the caps exist
// to keep a corrupted settings file or out-of-band write from passing
// pathological input to the picker. Each tag must be a non-empty,
// non-whitespace string of at most MAX_TAG_LENGTH characters.
const MAX_TAGS_PER_LIST = 50;
const tagsList = z
    .array(
        z
            .string()
            .min(1)
            .max(MAX_TAG_LENGTH)
            .refine((v) => v.trim().length > 0),
    )
    .max(MAX_TAGS_PER_LIST);

// Photo ids the user chose. Ids are opaque server tokens, so the safe-token
// shape (letters, digits, `_`, `-`; the mock ids fit) is all that is accepted:
// an id is only ever compared against the server's own eligible list, never
// sent anywhere. Duplicates are rejected rather than collapsed so the stored
// list is exactly what the chooser showed.
const photoIdList = z
    .array(z.string().regex(CHOSEN_PHOTO_ID_RE))
    .max(MAX_CHOSEN_PHOTOS)
    .refine((ids) => new Set(ids).size === ids.length);

export const autoFillSettings = {
    autoFill: {
        type: 'boolean',
        default: false,
        perChallenge: true,
        validation: zBool,
        validationOrder: 1,
        group: 'autoFill',
        label: 'app.autoFill',
        description: 'app.autoFillDesc',
    },
    protectUncertainAutoFills: {
        type: 'boolean',
        default: true,
        perChallenge: true,
        validation: zBool,
        validationOrder: 1,
        group: 'autoFill',
        label: 'app.protectUncertainAutoFills',
        description: 'app.protectUncertainAutoFillsDesc',
    },
    // A stored single autoFillIntervalMinutes value is migrated into this list
    // in settings/migrations/autoFillSchedule.ts (`_autoFillScheduleMigratedV1`). Default: 2 @ 30m,
    // 3 @ 20m, 4 @ 10m before close.
    autoFillSchedule: {
        type: 'schedule',
        default: [
            { count: 2, seconds: 1800 },
            { count: 3, seconds: 1200 },
            { count: 4, seconds: 600 },
        ],
        perChallenge: true,
        validation: fillSchedule,
        validationOrder: 1,
        group: 'autoFill',
        label: 'app.autoFillSchedule',
        description: 'app.autoFillScheduleDesc',
    },
    fillWithoutTagMatch: {
        type: 'boolean',
        default: true,
        perChallenge: true,
        validation: zBool,
        validationOrder: 1,
        group: 'autoFill',
        label: 'app.fillWithoutTagMatch',
        description: 'app.fillWithoutTagMatchDesc',
    },
    // Emergency fill only acts on scheduler cycles that actually run, so it
    // depends on cadence: keep emergencyFill <= lastMinuteThreshold and the
    // fast last-minute cadence is already active throughout the window. If it is
    // larger, the early part of the window relies on the slower normal cadence
    // (it still fires, just less tightly) — see emergencyFillDesc.
    emergencyFill: {
        type: 'time', // Special type for hours/minutes input (stored as seconds)
        default: 300, // 5 minutes in seconds
        perChallenge: true,
        // 0 is the off sentinel; otherwise seconds-before-close (mirrors boostTime/turboTime).
        validation: nonNegNumber,
        validationOrder: 1,
        group: 'autoFill',
        label: 'app.emergencyFill',
        description: 'app.emergencyFillDesc',
        helpKey: 'app.emergencyFillHelp',
    },
    mustIncludeTags: {
        type: 'tags',
        default: [],
        perChallenge: true,
        validation: tagsList,
        validationOrder: 1,
        group: 'autoFill',
        label: 'app.mustIncludeTags',
        description: 'app.mustIncludeTagsDesc',
    },
    shouldIncludeTags: {
        type: 'tags',
        default: [],
        perChallenge: true,
        validation: tagsList,
        validationOrder: 1,
        group: 'autoFill',
        label: 'app.shouldIncludeTags',
        description: 'app.shouldIncludeTagsDesc',
    },
    // The photos auto-join and auto-fill try first. They only FILTER the server's
    // own eligible list (a chosen id is never sent to the API) and are ranked by
    // the same scorer as every other candidate, so they must still fit the tag
    // settings. An empty list = no preference. Belongs to one member: see
    // chosenPhotosMemberId.
    chosenPhotos: {
        type: 'photos',
        default: [],
        perChallenge: true,
        validation: photoIdList,
        validationOrder: 1,
        group: 'autoFill',
        label: 'app.chosenPhotos',
        description: 'app.chosenPhotosDesc',
    },
    // With a non-empty chosenPhotos, never auto-pick: join and fill only submit
    // a chosen photo, and a challenge with none usable is skipped. With an empty
    // list it behaves as off.
    chosenPhotosOnly: {
        type: 'boolean',
        default: false,
        perChallenge: true,
        validation: zBool,
        validationOrder: 1,
        group: 'autoFill',
        label: 'app.chosenPhotosOnly',
        description: 'app.chosenPhotosOnlyDesc',
    },
    // Words to drop from a challenge TITLE before it is used as a theme.
    //
    // Challenge titles qualify their subject rather than just naming it — "Epic
    // Lighthouses", "Dramatic Storms", "Captivating Macro". The qualifier is not
    // a subject: it dilutes the pooled theme vector and, because only
    // SEARCH_TERMS_CAP terms are searched, it can push the real subject out
    // entirely. The series prefix in "Color Hunt: Green" is handled structurally
    // (see titleSubject in services/photoPicker/title.ts) and needs no entry here.
    //
    // Seeded rather than hardcoded on purpose: every word is visible and
    // removable. Delete one if a challenge genuinely IS about it — "Negative
    // Space" is a real photographic subject, which is why "negative" is not in
    // this list.
    ignoreTitleWords: {
        type: 'tags',
        default: [
            'epic',
            'dramatic',
            'captivating',
            'fascinating',
            'powerful',
            'beautiful',
            'amazing',
            'stunning',
            'incredible',
            'breathtaking',
            'gorgeous',
            'glorious',
            'spectacular',
            'magical',
            'majestic',
            'striking',
            'wonderful',
            'awesome',
            'lovely',
            'perfect',
            'ultimate',
            'extreme',
            'favorite',
            'favourite',
            'melodic',
            'little',
            'creative',
            'creatively',
        ],
        perChallenge: true,
        validation: tagsList,
        validationOrder: 1,
        group: 'autoFill',
        label: 'app.ignoreTitleWords',
        description: 'app.ignoreTitleWordsDesc',
    },
} satisfies Record<string, SettingsSchemaEntry>;
