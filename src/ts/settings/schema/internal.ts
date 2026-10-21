/**
 * Settings with no UI group: persisted state that is never rendered in a
 * settings section, so SETTINGS_GROUPS has no entry for them.
 */

import { z } from 'zod';
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
    // The launch time (Unix ms) of the app launch whose renderer last started a
    // session, written just before autovoteRunning. The main process compares it
    // for equality with its own launch time to tell a session started in this
    // launch from one still held at launch. 0 = unknown / never started.
    autovoteStartedLaunch: {
        type: 'number',
        default: 0,
        perChallenge: false,
        validation: z.number().int().min(0),
        min: 0,
        unit: 'app.unitMilliseconds',
        validationOrder: 1,
        label: 'app.autovoteStartedLaunch',
        description: 'app.autovoteStartedLaunchDesc',
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
    // The version of the "unofficial / not affiliated" notice the user acknowledged
    // (noticeVersion.ts holds the current one). The notice shows while this is below
    // it; 0 = never acknowledged.
    noticeAcknowledgedVersion: {
        type: 'number',
        default: 0,
        perChallenge: false,
        validation: z.number().int().min(0),
        min: 0,
        validationOrder: 1,
        label: 'app.noticeAcknowledgedVersion',
        description: 'app.noticeAcknowledgedVersionDesc',
    },
} satisfies Record<string, SettingsSchemaEntry>;
