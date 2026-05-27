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
 *   - boost group    → flash challenge (no boost); boost already USED; or the
 *                      only entry slot is full with a turboed entry (Boost and
 *                      Turbo can't share an entry and there's no room for a new
 *                      one — mirrors api/boost.js's _pickBoostEntry returning null)
 *   - turbo group    → flash or exhibition challenge (no turbo); turbo already USED
 *   - autoFill group → all entry slots full
 * Deliberately NOT boost/turbo UNAVAILABLE/LOCKED, which can still flip to
 * available later, so the user must remain able to pre-configure those. The
 * turbo-conflict and slots-full checks are reversible (deleting a photo frees a
 * slot / clears the conflict), which is fine — applicability is recomputed live.
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
    // Shared slot state — used by both the autoFill "all full" check and the
    // boost "turboed-only-entry" conflict check, so derive it once.
    const entries = member.ranking?.entries || [];
    const maxSlots = challenge.max_photo_submits || 0;
    const slotsFull = maxSlots > 0 && entries.length >= maxSlots;

    switch (groupId) {
        case 'boost': {
            if (challenge.type === 'flash') return { applicable: false, reasonKey: 'app.naFlashNoBoost' };
            if (member.boost?.state === 'USED') return { applicable: false, reasonKey: 'app.naBoostUsed' };
            // Boost and Turbo can't sit on the same entry. If every filled slot
            // is turboed and there's no free slot for a fresh photo, boost can
            // never be placed: api/boost.js applyBoost returns null, and
            // boostFillNew can't rescue it because autoFill.submitNewEntryForAction
            // refuses once slots are full. With GuruShots' one-turbo-per-challenge
            // rule this only bites at 1/1.
            if (slotsFull && entries.length > 0 && entries.every((e) => e?.turbo)) {
                return { applicable: false, reasonKey: 'app.naBoostTurboConflict' };
            }
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
