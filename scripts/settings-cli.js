#!/usr/bin/env node

const settings = require('../src/js/settings');
const logger = require('../src/js/logger');
const { parseSettingValue } = require('../src/js/cli/parseValue');
const { dumpSchema, listGlobalDefaults } = require('../src/js/cli/commands/settings');
const { spawn } = require('node:child_process');

/**
 * CLI Settings Management Script
 *
 * Usage:
 *   pnpm settings:get [key]     - Get setting value (or all if no key provided)
 *   pnpm settings:set key value - Set setting value
 *
 * Sensitive keys (token etc.) print as [REDACTED]; pass --reveal to `get`
 * to print the raw value.
 *
 * Examples:
 *   pnpm settings:get            # Get all settings
 *   pnpm settings:get theme      # Get theme setting
 *   pnpm settings:set theme dark # Set theme to dark
 *   pnpm settings:set challengeSettings.globalDefaults.boostTime 7200
 */

// --reveal opts `get` out of sensitive-key redaction (the legitimate
// read-my-own-token workflow). Strip it before positional parsing so it
// can appear anywhere in the arg list.
const cliArgs = process.argv.slice(2).filter((arg) => arg !== '--reveal');
const reveal = process.argv.includes('--reveal');

const command = cliArgs[0];
const key = cliArgs[1];
const value = cliArgs[2];

// Helper function to get nested property value
function getNestedProperty(obj, path) {
    return path.split('.').reduce((current, key) => {
        return current && current[key] !== undefined ? current[key] : undefined;
    }, obj);
}

// Helper function to format output
function formatValue(value, indent = 0) {
    const spaces = '  '.repeat(indent);

    if (value === null) return 'null';
    if (value === undefined) return 'undefined';

    if (typeof value === 'object' && !Array.isArray(value)) {
        if (Object.keys(value).length === 0) {
            return '{}';
        }

        let result = '{\n';
        Object.entries(value).forEach(([k, v]) => {
            result += `${spaces}  ${k}: ${formatValue(v, indent + 1)}\n`;
        });
        result += `${spaces}}`;
        return result;
    }

    if (Array.isArray(value)) {
        if (value.length === 0) {
            return '[]';
        }
        return '[' + value.map((v) => JSON.stringify(v)).join(', ') + ']';
    }

    return JSON.stringify(value);
}

// Function to check if Electron GUI is running
function isElectronRunning() {
    return new Promise((resolve) => {
        const process = spawn('pgrep', ['-f', 'electron.*gurushots-auto-vote'], { stdio: 'pipe' });

        // Add timeout to prevent hanging
        const timeout = setTimeout(() => {
            process.kill();
            resolve(false);
        }, 2000); // 2 second timeout

        process.on('close', (code) => {
            clearTimeout(timeout);
            resolve(code === 0);
        });

        process.on('error', () => {
            clearTimeout(timeout);
            resolve(false);
        });
    });
}

// Function to inform about GUI auto-reload
async function informAboutGuiReload() {
    try {
        const isRunning = await isElectronRunning();
        if (isRunning) {
            console.log('🔄 GUI detected - changes will be applied automatically');
        }
    } catch {
        // Silently ignore errors - GUI might not be running
    }
}

async function main() {
    try {
        switch (command) {
            case 'get': {
                const allSettings = settings.loadSettings();

                // Redact sensitive keys (token etc.) unless --reveal was
                // passed — sanitizeForLog deep-masks by key name, so nested
                // sensitive values inside objects are covered too.
                const forDisplay = (val, keyName = null) => {
                    if (reveal) return val;
                    const wrapped = keyName === null ? val : { [keyName]: val };
                    const masked = logger.sanitizeForLog(wrapped);
                    return keyName === null ? masked : masked[keyName];
                };

                if (!key) {
                    // Show all settings
                    console.log('All Settings:');
                    console.log(formatValue(forDisplay(allSettings)));
                } else {
                    // Show specific setting
                    const value = getNestedProperty(allSettings, key);
                    if (value === undefined) {
                        console.error(`Setting '${key}' not found`);
                        process.exit(1);
                    } else {
                        const leafKey = key.split('.').pop();
                        console.log(`${key}: ${formatValue(forDisplay(value, leafKey))}`);
                    }
                }
                break;
            }

            case 'set': {
                if (!key || value === undefined) {
                    console.error('Usage: pnpm settings:set <key> <value>');
                    console.error('Example: pnpm settings:set theme dark');
                    process.exit(1);
                }

                const parsedValue = parseSettingValue(value);

                // Handle nested keys for schema-based global defaults
                if (key.startsWith('challengeSettings.globalDefaults.')) {
                    const settingKey = key.replace('challengeSettings.globalDefaults.', '');
                    const schema = settings.SETTINGS_SCHEMA;

                    if (schema[settingKey]) {
                        // Use schema-based validation for global defaults
                        const success = settings.setGlobalDefault(settingKey, parsedValue);
                        if (success) {
                            const actualValue = settings.getGlobalDefault(settingKey);
                            console.log(`✅ Set global default ${settingKey} = ${formatValue(actualValue)}`);
                            await informAboutGuiReload();
                        } else {
                            console.error(`❌ Failed to set global default '${settingKey}' - validation failed`);
                            console.error(`   Value ${formatValue(parsedValue)} is invalid for this setting`);
                            process.exit(1);
                        }
                    } else {
                        console.error(`❌ Unknown schema setting '${settingKey}'`);
                        console.error('   Run "pnpm settings:schema" to see available settings');
                        process.exit(1);
                    }
                } else if (key.includes('.')) {
                    // Arbitrary nested writes used to poke raw JSON into the
                    // settings blob, bypassing schema validation entirely —
                    // removed. Only the supported forms remain.
                    console.error(`❌ Unsupported nested key '${key}'`);
                    console.error('   Supported forms:');
                    console.error('     pnpm settings:set <topLevelKey> <value>');
                    console.error('     pnpm settings:set challengeSettings.globalDefaults.<schemaKey> <value>');
                    console.error('     pnpm settings:set-global <schemaKey> <value>');
                    process.exit(1);
                } else {
                    // Handle top-level settings
                    const success = settings.setSetting(key, parsedValue);
                    if (success) {
                        console.log(`✅ Set ${key} = ${formatValue(parsedValue)}`);

                        // Inform about GUI reload for certain settings
                        const uiSettings = ['theme', 'language', 'timezone'];
                        if (uiSettings.includes(key)) {
                            await informAboutGuiReload();
                        }
                    } else {
                        console.error(`❌ Failed to save setting '${key}' - validation failed`);
                        process.exit(1);
                    }
                }
                break;
            }

            case 'schema': {
                // Shared with the main CLI (src/js/cli/commands/settings.js).
                dumpSchema();
                break;
            }

            case 'global-defaults': {
                // Shared with the main CLI (src/js/cli/commands/settings.js).
                listGlobalDefaults();
                break;
            }

            case 'reset': {
                if (!key) {
                    console.error('Usage: pnpm settings:reset <key>');
                    console.error('Example: pnpm settings:reset theme');
                    process.exit(1);
                }

                const success = settings.resetSetting(key);
                if (success) {
                    const defaultSettings = settings.getDefaultSettings();
                    console.log(`✅ Reset ${key} to default value: ${formatValue(defaultSettings[key])}`);

                    // Check if GUI is running and inform about reload
                    const uiSettings = ['theme', 'language', 'timezone'];
                    if (uiSettings.includes(key)) {
                        await informAboutGuiReload();
                    }
                } else {
                    console.error(`❌ Failed to reset setting '${key}'`);
                    process.exit(1);
                }
                break;
            }

            case 'reset-global': {
                if (!key) {
                    console.error('Usage: pnpm settings:reset-global <settingKey>');
                    console.error('Example: pnpm settings:reset-global boostTime');
                    process.exit(1);
                }

                const success = settings.resetGlobalDefault(key);
                if (success) {
                    const schema = settings.SETTINGS_SCHEMA;
                    const defaultValue = schema[key]?.default;
                    console.log(`✅ Reset global default ${key} to: ${formatValue(defaultValue)}`);
                    await informAboutGuiReload();
                } else {
                    console.error(`❌ Failed to reset global default '${key}'`);
                    process.exit(1);
                }
                break;
            }

            case 'set-global': {
                if (!key || value === undefined) {
                    console.error('Usage: pnpm settings:set-global <settingKey> <value>');
                    console.error('Example: pnpm settings:set-global exposure 80');
                    console.error('Example: pnpm settings:set-global lastHourExposure 70');
                    process.exit(1);
                }

                const parsedValue = parseSettingValue(value);

                const schema = settings.SETTINGS_SCHEMA;
                if (!schema[key]) {
                    console.error(`❌ Unknown schema setting '${key}'`);
                    console.error('   Run "pnpm settings:schema" to see available settings');
                    process.exit(1);
                }

                // Use schema-based validation for global defaults
                const success = settings.setGlobalDefault(key, parsedValue);
                if (success) {
                    const actualValue = settings.getGlobalDefault(key);
                    console.log(`✅ Set global default ${key} = ${formatValue(actualValue)}`);
                    await informAboutGuiReload();
                } else {
                    console.error(`❌ Failed to set global default '${key}' - validation failed`);
                    console.error(`   Value ${formatValue(parsedValue)} is invalid for this setting`);

                    // Show validation constraints
                    const config = schema[key];
                    if (config.validation) {
                        console.error(`   Constraints: ${config.type} type, valid range varies by setting`);
                    }
                    process.exit(1);
                }
                break;
            }

            case 'reset-all': {
                const confirmMessage =
                    'Are you sure you want to reset ALL settings to their default values?\nThis will reset all UI settings, global challenge defaults, window positions, and preferences.\nOnly your login token, last update check time, mock mode setting, and API headers will be preserved.\nType "yes" to confirm:';

                console.log(confirmMessage);

                // In a real CLI, we'd use readline, but for pnpm scripts this is a simple confirmation
                if (key !== 'yes') {
                    console.log('Reset cancelled. To confirm, run: pnpm settings:reset-all yes');
                    process.exit(0);
                }

                const uiSuccess = settings.resetAllSettings();
                const globalSuccess = settings.resetAllGlobalDefaults();

                if (uiSuccess && globalSuccess) {
                    console.log('✅ Successfully reset all settings to defaults');
                    await informAboutGuiReload();
                } else {
                    console.error('❌ Failed to reset some settings');
                    process.exit(1);
                }
                break;
            }

            case 'help':
            default: {
                console.log('Settings CLI Help');
                console.log('================');
                console.log('');
                console.log('Available commands:');
                console.log('  pnpm settings:get [key] [--reveal]  - Get setting value (all if no key)');
                console.log('                                        Sensitive keys (token etc.) print as');
                console.log('                                        [REDACTED] unless --reveal is passed');
                console.log('  pnpm settings:set <key> <value>     - Set setting value');
                console.log('  pnpm settings:set-global <key> <val> - Set global default (with validation)');
                console.log('  pnpm settings:reset <key>           - Reset setting to default value');
                console.log('  pnpm settings:reset-global <key>    - Reset global default to schema default');
                console.log('  pnpm settings:reset-all yes         - Reset all settings to defaults');
                console.log('  pnpm settings:schema                - Show settings schema');
                console.log('  pnpm settings:global-defaults       - Show global defaults');
                console.log('  pnpm settings:help                  - Show this help');
                console.log('  pnpm gui:refresh                 - Get info about refreshing GUI');
                console.log('');
                console.log('Examples:');
                console.log('  pnpm settings:get');
                console.log('  pnpm settings:get theme');
                console.log('  pnpm settings:set theme dark');
                console.log('  pnpm settings:set stayLoggedIn true');
                console.log('  pnpm settings:set-global exposure 80');
                console.log('  pnpm settings:set-global lastHourExposure 70');
                console.log('  pnpm settings:set challengeSettings.globalDefaults.boostTime 7200');
                console.log('  pnpm settings:reset theme');
                console.log('  pnpm settings:reset-global boostTime');
                console.log('  pnpm settings:reset-all yes');
                console.log('');
                console.log('Notes:');
                console.log('  - Values are automatically parsed (JSON, numbers, booleans)');
                console.log('  - Use dot notation for nested properties');
                console.log('  - CLI only supports global settings, not per-challenge overrides');
                console.log('  - GUI refresh (Ctrl+R / Cmd+R) needed for theme/language/timezone changes');
                console.log('  - Individual reset commands preserve current values until saved');
                console.log('  - Reset-all preserves only login token, last update check, mock mode, and API headers');
                break;
            }
        }
    } catch (error) {
        console.error('❌ Error:', error.message);
        process.exit(1);
    }
}

main()
    .then(() => {
        process.exit(0);
    })
    .catch((error) => {
        console.error('❌ Unhandled error:', error.message);
        process.exit(1);
    });
