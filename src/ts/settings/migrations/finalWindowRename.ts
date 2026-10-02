import * as logger from '../../logger';
import { _eachScheduledFillScope } from './scopes';

import type { AppSettings } from '../../types/settings';

// Rename the "last hour exposure" feature keys to their "final window"
// equivalents (the window length is the configurable finalWindowDuration
// setting). A pure key rename that must run BEFORE cleanupObsoleteSettings,
// which would otherwise delete the schemaless old keys and lose the user's
// persisted values. Walks all three scopes via _eachScheduledFillScope
// (globalDefaults, every perChallenge map, every non-reserved profile). The new
// finalWindowDuration setting needs no migration: absent → schema default 3600,
// the one-hour window the renamed keys were configured against.
export const migrateFinalWindowExposureRename = (mergedSettings: AppSettings): boolean => {
    if (mergedSettings._finalWindowExposureRenamedV1) return false;

    const RENAMES = {
        useLastHourExposure: 'useFinalWindowExposure',
        lastHourExposure: 'finalWindowExposure',
        lastHourExposureTarget: 'finalWindowExposureTarget',
        voteBeforeLastHour: 'voteBeforeFinalWindow',
        voteBeforeLastHourLeadMin: 'voteBeforeFinalWindowLeadMin',
    };

    _eachScheduledFillScope(mergedSettings, (scope, label) => {
        if (!scope) return;
        for (const [oldKey, newKey] of Object.entries(RENAMES)) {
            if (!Object.prototype.hasOwnProperty.call(scope, oldKey)) continue;
            // Preserve an existing new-key value (already migrated / new write)
            // over the legacy one; still drop the stale old key either way.
            if (!Object.prototype.hasOwnProperty.call(scope, newKey)) {
                scope[newKey] = scope[oldKey];
                logger
                    .withCategory('settings')
                    .info(`Renamed ${oldKey} ${label} to ${newKey} (value ${JSON.stringify(scope[oldKey])})`, null);
            }
            delete scope[oldKey];
        }
    });

    mergedSettings._finalWindowExposureRenamedV1 = true;
    return true;
};
