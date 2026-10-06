/**
 * A setting value as it may appear in a log line.
 */

import { schemaEntry } from './schema';

/**
 * The value to log for a setting: a photo list is only counted, never listed —
 * its ids belong to one account — and every other value is returned as is.
 */
const loggableSettingValue = (settingKey: string, value: unknown): unknown =>
    schemaEntry(settingKey)?.type === 'photos' && Array.isArray(value) ? `${value.length} photo(s)` : value;

export { loggableSettingValue };
