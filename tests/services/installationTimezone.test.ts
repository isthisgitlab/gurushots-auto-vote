/**
 * The installation's effective time zone at a boundary (services/installationTimezone.ts): read through the installation
 * capture, never from the saved value when that cannot be read.
 */

jest.mock('../../src/ts/core/settings', () => ({ captureInstallationSettings: jest.fn() }));

import settingsModule = require('../../src/ts/core/settings');
const settings = jest.mocked(settingsModule);
import type * as moduleUnderTest from '../../src/ts/core/services/installationTimezone';
const { captureInstallationTimezone } =
    require('../../src/ts/core/services/installationTimezone') as typeof moduleUnderTest;

test('the zone the installation captures; an empty one is UTC and an unknown one is UTC, as everywhere', () => {
    settings.captureInstallationSettings.mockReturnValue({ ok: true, values: { timezone: 'Europe/Riga' } });
    expect(captureInstallationTimezone()).toBe('Europe/Riga');
    expect(settings.captureInstallationSettings).toHaveBeenCalledWith(['timezone']);
    settings.captureInstallationSettings.mockReturnValue({ ok: true, values: { timezone: '' } });
    expect(captureInstallationTimezone()).toBe('UTC');
    settings.captureInstallationSettings.mockReturnValue({ ok: true, values: { timezone: 'Not/AZone' } });
    expect(captureInstallationTimezone()).toBe('UTC');
});

test('one that cannot be read is null: no saved zone takes its place', () => {
    settings.captureInstallationSettings.mockReturnValue({
        ok: false,
        key: 'timezone',
        reason: 'the published settings have expired',
    });
    expect(captureInstallationTimezone()).toBeNull();
});
