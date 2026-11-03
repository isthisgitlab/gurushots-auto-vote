/**
 * The overlay that puts the phone's view keys over a desktop settings object: a copy is
 * answered and the desktop object is left untouched. Only an id the phone holds changes —
 * an unheld one keeps the desktop's record exactly as it arrived. Loaded only by the remote
 * renderer entries, so it stays free of Node-side modules.
 */

import { isPlainObject } from '../../../core/plainObject';

import { isBoolean, normalizeId } from './viewPrefsStore';

import type { Stored } from './viewPrefsStore';

/** The phone's four keys over a desktop settings object: a copy, the desktop object untouched. */
export const overlaySettings = (stored: Stored, payload: Record<string, unknown>): unknown => {
    const out: Record<string, unknown> = { ...payload };
    if (stored.theme !== undefined || stored.language !== undefined) {
        if (isPlainObject(payload.app)) {
            const app: Record<string, unknown> = { ...payload.app };
            if (stored.theme !== undefined) app.theme = stored.theme;
            if (stored.language !== undefined) app.language = stored.language;
            out.app = app;
        }
    }
    if (stored.compactCards !== undefined || stored.compactCardActions !== undefined) {
        if (isPlainObject(payload.defaults)) {
            const defaults: Record<string, unknown> = { ...payload.defaults };
            if (stored.compactCards !== undefined) defaults.compactCards = stored.compactCards;
            if (stored.compactCardActions !== undefined) defaults.compactCardActions = stored.compactCardActions;
            out.defaults = defaults;
        }
    }
    if (isPlainObject(payload.challenges)) {
        const challenges: Record<string, unknown> = { ...payload.challenges };
        for (const [key, record] of Object.entries(payload.challenges)) {
            const id = normalizeId(key);
            // Only an id the phone holds changes: an unheld one keeps the desktop's record
            // exactly as it arrived, its `compactCards` present or absent.
            if (id === '' || !isPlainObject(record)) continue;
            const own = Object.hasOwn(stored.compactOverrides, id) ? stored.compactOverrides[id] : undefined;
            if (own === undefined) continue;
            const values = isPlainObject(record.values) ? record.values : undefined;
            if (isBoolean(own)) {
                // The phone's own override shows; a container the desktop payload lacks is created for it.
                challenges[key] = { ...record, values: { ...values, compactCards: own } };
            } else if (values !== undefined && Object.hasOwn(values, 'compactCards')) {
                // Seeded as none: the key is left out — never `compactCards: null`,
                // which would count the challenge as customized.
                const next: Record<string, unknown> = { ...values };
                delete next.compactCards;
                challenges[key] = { ...record, values: next };
            }
        }
        out.challenges = challenges;
    }
    return out;
};
