/**
 * The photo chooser's pin draft: per kind the pin the next save writes (an id, or null to clear), or
 * absent while the kind is still what the stored pins say. Pure over the draft and the stored pins —
 * the modal owns the React state and makes the ipc calls.
 */

import { applyPinToRecord } from '../../voting/entryPins';

import type { EntryPinKind, EntryPinRecord, EntryPins } from '../../types/settings';

// The two features a chosen photo can be pinned for, in save order.
const PIN_KINDS = ['boost', 'turbo'] as const;

/**
 * The chooser's pin draft: per kind the pin to save (an id, or null to clear), or absent while the kind
 * is still what the stored pins say.
 */
type PinDraft = { [K in EntryPinKind]?: string | null };

/** The pin a kind would save: the draft's value when it has one, the stored pin otherwise. */
const pinOf = (draft: PinDraft, stored: EntryPins, kind: EntryPinKind): string | null => {
    const value = draft[kind];
    return value === undefined ? stored[kind] : value;
};

/**
 * The draft after a toggle of `imageId` for `kind`. The set-and-clear goes through the one rule the
 * stored write uses (`applyPinToRecord`), over a record of the effective pins: pinning a photo for
 * one kind gives the other kind's pin on the same photo way, and toggling the kind's pin off drafts
 * its clear. What the rule leaves as it is keeps the previous draft (an earlier explicit clear
 * survives), and a draft value equal to the stored pin is dropped, so a toggle taken back is no
 * unsaved change.
 */
const toggledPinDraft = (prev: PinDraft, stored: EntryPins, kind: EntryPinKind, imageId: string): PinDraft => {
    const other: EntryPinKind = kind === 'boost' ? 'turbo' : 'boost';
    // The effective pins of the kind and its opposite, as a record the write rule can run on.
    const target: EntryPinRecord = {};
    for (const changed of [kind, other]) {
        const pinned = pinOf(prev, stored, changed);
        if (pinned !== null) target[changed] = pinned;
    }
    applyPinToRecord(target, kind, pinOf(prev, stored, kind) === imageId ? null : imageId);
    const next: PinDraft = { ...prev };
    next[kind] = target[kind] ?? null;
    // The rule took the other kind's pin on the same photo away: the save drafts its clear.
    if (target[other] === undefined && pinOf(prev, stored, other) !== null) next[other] = null;
    for (const changed of [kind, other]) {
        if (next[changed] === stored[changed]) delete next[changed];
    }
    return next;
};

/** The draft after `imageId` left the selection: a draft pin naming it is dropped, back to the stored pin. */
const pinDraftWithout = (prev: PinDraft, imageId: string): PinDraft => {
    const next: PinDraft = { ...prev };
    for (const kind of PIN_KINDS) {
        if (next[kind] === imageId) {
            delete next[kind];
        }
    }
    return next;
};

/**
 * The ordered pin writes of a save: one per changed kind, in save order. A null whose stored photo
 * the draft moved to the other kind is not sent: that write clears it atomically, so a partial state
 * cannot survive a failed second write.
 */
const planPinCommits = (draft: PinDraft, stored: EntryPins): { kind: EntryPinKind; imageId: string | null }[] => {
    const plan: { kind: EntryPinKind; imageId: string | null }[] = [];
    for (const kind of PIN_KINDS) {
        const imageId = draft[kind];
        if (imageId === undefined) continue;
        const other: EntryPinKind = kind === 'boost' ? 'turbo' : 'boost';
        if (imageId === null && stored[kind] === draft[other]) continue;
        plan.push({ kind, imageId });
    }
    return plan;
};

export { PIN_KINDS, pinOf, toggledPinDraft, pinDraftWithout, planPinCommits };
export type { PinDraft };
