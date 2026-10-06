/**
 * Settings with no UI group: persisted state that is never rendered in a
 * settings section, so SETTINGS_GROUPS has no entry for them.
 */

import { zBool, zString } from './validators';
import type { SettingsSchemaEntry } from './entry';

export const internalSettings = {
    // Persisted autovote-running flag. Written on Start / Stop so a
    // relaunch of the app (Capacitor WebView destroyed + recreated,
    // Electron window reopen) can resume voting without the user
    // tapping Start again.
    autovoteRunning: {
        type: 'boolean',
        default: false,
        perChallenge: false,
        validation: zBool,
        validationOrder: 1,
        label: 'app.autovoteRunning',
        description: 'app.autovoteRunningDesc',
    },
    // Update version the user chose to skip. Electron persists this in
    // metadata.json (fs); the Android/Capacitor bridge has no fs, so it
    // routes skip-update-version through the settings facade instead, which
    // has a platform-agnostic transport (@capacitor/preferences). Empty
    // string means "nothing skipped".
    skipUpdateVersion: {
        type: 'string',
        default: '',
        perChallenge: false,
        validation: zString,
        validationOrder: 1,
        label: 'app.skipUpdateVersion',
        description: 'app.skipUpdateVersionDesc',
    },
    // The member who last saved a chosen-photos list through the settings IPC.
    // Photo ids belong to one account, so when the logged-in member differs both
    // chosen settings are ignored (see services/autoFill/chosenPhotos.ts).
    // Empty = never recorded (no member known when it was saved).
    chosenPhotosMemberId: {
        type: 'string',
        default: '',
        perChallenge: false,
        validation: zString,
        validationOrder: 1,
        label: 'app.chosenPhotosMemberId',
        description: 'app.chosenPhotosMemberIdDesc',
    },
    // When every saved chosen-photos list was last removed (an ISO time, '' = never). It rides along
    // in every settings-changed broadcast, so an editor opened before a removal made elsewhere
    // (the CLI, another window) learns of it and drops its draft copy of the lists.
    chosenPhotosClearedAt: {
        type: 'string',
        default: '',
        perChallenge: false,
        validation: zString,
        validationOrder: 1,
        label: 'app.chosenPhotosClearedAt',
        description: 'app.chosenPhotosClearedAtDesc',
    },
} satisfies Record<string, SettingsSchemaEntry>;
