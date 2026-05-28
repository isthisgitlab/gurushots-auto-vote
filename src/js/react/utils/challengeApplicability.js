/**
 * Per-challenge settings applicability.
 *
 * Decides, for a per-challenge settings GROUP (see SETTINGS_GROUPS), whether
 * that group's settings can still take effect on a challenge given its CURRENT
 * live state. Used by ChallengeSettingsModal to grey out + annotate groups
 * whose action can never happen again this challenge.
 *
 * Pure renderer util (no Node/service deps), mirroring formatters.js /
 * groupSettings.js — derived fresh on every render from the live `challenge`
 * object. The result is never persisted and never mutates an override: when the
 * challenge state changes (e.g. a freed entry slot), the group re-enables on
 * the next render automatically.
 *
 * Conditions where a group's action can't take effect:
 *   - boost group    → flash challenge (no boost); boost already USED; or a
 *                      single-photo challenge (max_photo_submits === 1), where
 *                      Boost never unlocks — its state stays LOCKED for the whole
 *                      challenge and can never reach AVAILABLE.
 *   - turbo group    → flash or exhibition challenge (no turbo); turbo already USED
 *   - autoFill group → all entry slots full
 * Deliberately NOT boost/turbo UNAVAILABLE/LOCKED on multi-photo challenges, where
 * those states are transient ("not unlocked yet") and can still flip to AVAILABLE
 * later, so the user must remain able to pre-configure them. The single-photo and
 * slots-full checks are reversible against live state (it never changes mid-
 * challenge, but a fresh challenge prop is re-evaluated every render).
 *
 * @param {string} groupId - One of the SETTINGS_GROUPS ids.
 * @param {object|null} [challenge] - Challenge object (reads challenge.member.*).
 *   When absent (modal closed / unit context) everything is applicable.
 * @returns {{ applicable: boolean, reasonKey: string|null }} reasonKey is a
 *   translation key when not applicable, otherwise null.
 */
export function getGroupApplicability(groupId, challenge) {
    const applicable = { applicable: true, reasonKey: null };
    if (!challenge) return applicable;

    const member = challenge.member || {};
    // Slot state. maxSlots drives the boost single-photo check (=== 1) and the
    // autoFill "all full" check; entries feeds slotsFull. Derive once.
    const entries = member.ranking?.entries || [];
    const maxSlots = challenge.max_photo_submits || 0;
    const slotsFull = maxSlots > 0 && entries.length >= maxSlots;

    switch (groupId) {
        case 'boost': {
            if (challenge.type === 'flash') return { applicable: false, reasonKey: 'app.naFlashNoBoost' };
            if (member.boost?.state === 'USED') return { applicable: false, reasonKey: 'app.naBoostUsed' };
            // A single-photo challenge never unlocks Boost: its boost state stays
            // LOCKED for the whole challenge and can never reach AVAILABLE — unlike
            // a multi-photo challenge, where LOCKED is transient and may flip to
            // AVAILABLE later, so those must stay configurable. maxSlots === 1 also
            // subsumes the old Boost-vs-Turbo conflict (Boost and Turbo can't share
            // an entry, and with one turbo per challenge that only ever bit at 1/1).
            if (maxSlots === 1) return { applicable: false, reasonKey: 'app.naBoostSinglePhoto' };
            return applicable;
        }

        case 'turbo': {
            if (challenge.type === 'flash') return { applicable: false, reasonKey: 'app.naFlashNoTurbo' };
            if (challenge.type === 'exhibition') return { applicable: false, reasonKey: 'app.naExhibitionNoTurbo' };
            return member.turbo?.state === 'USED' ? { applicable: false, reasonKey: 'app.naTurboUsed' } : applicable;
        }

        case 'autoFill':
            return slotsFull ? { applicable: false, reasonKey: 'app.naSlotsFull' } : applicable;

        default:
            return applicable;
    }
}
