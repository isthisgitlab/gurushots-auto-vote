/**
 * The node family as a whole: the platform createNodePlatform builds. The
 * members the node platforms have none of are null; the windows are no-ops;
 * the log context resolves on each call.
 */

import { createNodePlatform } from '../../../src/ts/platforms/node';
import * as context from '../../../src/ts/logger/context';

describe('the node platform', () => {
    test('it has no adapter, native services or Capacitor transport', () => {
        const p = createNodePlatform();
        expect(p.http.adapter).toBeNull();
        expect(p.native).toEqual({ autovote: null, foregroundService: null, apkInstaller: null });
        expect(p.wipe.clearSession).toBeNull();
        expect(p.wipe.reloadAfterWipe).toBe(false);
        expect(p.wipe.listPreferenceKeys).toBeNull();
        expect(p.wipe.removePreferenceKeys).toBeNull();
    });

    test('the wipe finds no native plugin to ask, as localData answers without one', async () => {
        await expect(createNodePlatform().wipe.nativeWipe()).resolves.toBeNull();
    });

    test('its windows are no-ops', () => {
        const p = createNodePlatform();
        expect(() => p.windows.broadcastSettingsChanged({})).not.toThrow();
        expect(() => p.windows.afterWipe()).not.toThrow();
    });

    test('the constants name the node answers', () => {
        const c = createNodePlatform().capabilities;
        expect(c.refreshMissionNeeds).toBe(false);
        expect(c.snapAllowed).toBe(true);
        expect(c.recoveryWording).toBe('file');
        expect(c.logCleanup).toBe(false);
    });

    test('no background service owns the scenarios here', () => {
        expect(createNodePlatform().capabilities.backgroundServiceOwnsScenarios()).toBe(false);
    });

    test('the log context is resolved on each call', () => {
        const p = createNodePlatform();
        expect(p.capabilities.logContext()).toBe('CLI');
        context.setContext('GUI');
        expect(p.capabilities.logContext()).toBe('GUI');
        context.clearContext();
        expect(p.capabilities.logContext()).toBe('CLI');
    });
});
