/**
 * A setting value as it may appear in a log line.
 */

import { maskSettingValue } from '../format/settingsLogMask';

/**
 * The value to log for a setting, as it came, valid or not: a photo list is only counted, never listed — its ids belong
 * to one account, wherever in the value they sit — credentials are redacted, and every other value is returned as is.
 */
const loggableSettingValue = (settingKey: string, value: unknown): unknown =>
    maskSettingValue({ [settingKey]: value })[settingKey];

export { loggableSettingValue };
