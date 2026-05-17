#!/usr/bin/env node

const settings = require('../src/js/settings');
const { parseSettingValue } = require('../src/js/cli/parseValue');
const { spawn } = require('node:child_process');

/**
 * CLI Settings Management Script
 *
 * Usage:
 *   pnpm settings:get [key]     - Get setting value (or all if no key provided)
 *   pnpm settings:set key value - Set setting value
 *
 * Examples:
 *   pnpm settings:get            # Get all settings
 *   pnpm settings:get theme      # Get theme setting
 *   pnpm settings:set theme dark # Set theme to dark
 *   pnpm settings:set challengeSettings.globalDefaults.boostTime 7200
 */

const command = process.argv[2];
const key = process.argv[3];
const value = process.argv[4];

// Helper function to get nested property value
function getNestedProperty(obj, path) {
    return path.split('.').reduce((current, key) => {
        return current && current[key] !== undefined ? current[key] : undefined;
    }, obj);
}

// Helper function to set nested property value
function setNestedProperty(obj, path, value) {
    const keys = path.split('.');
    const lastKey = keys.pop();
    const target = keys.reduce((current, key) => {
        if (!current[key] || typeof current[key] !== 'object') {
            current[key] = {};
        }
        return current[key];
    }, obj);

    target[lastKey] = parseSettingValue(value);
    return obj;
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

                if (!key) {
                    // Show all settings
                    console.log('All Settings:');
                    console.log(formatValue(allSettings));
                } else {
                    // Show specific setting
                    const value = getNestedProperty(allSettings, key);
                    if (value === undefined) {
                        console.error(`Setting '${key}' not found`);
                        process.exit(1);
                    } else {
                        console.log(`${key}: ${formatValue(value)}`);
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
                    // Handle other nested keys by modifying the settings object directly
                    const allSettings = settings.loadSettings();
                    setNestedProperty(allSettings, key, parsedValue);
                    const success = settings.saveSettings(allSettings);
                    if (success) {
                        console.log(`✅ Set ${key} = ${formatValue(getNestedProperty(allSettings, key))}`);

                        // Inform about GUI reload for certain settings
                        const uiSettings = ['theme', 'language', 'timezone'];
                        const mainKey = key.split('.')[0];
                        if (
                            uiSettings.includes(mainKey) ||
                            key.includes('theme') ||
                            key.includes('language') ||
                            key.includes('timezone')
                        ) {
                            await informAboutGuiReload();
                        }
                    } else {
                        console.error(`❌ Failed to save setting '${key}' - validation failed`);
                        process.exit(1);
                    }
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
                // Show settings schema information
                const schema = settings.SETTINGS_SCHEMA;
                console.log('Settings Schema:');
                console.log('================');

                Object.entries(schema).forEach(([key, config]) => {
                    console.log(`\n${key}:`);
                    console.log(`  Type: ${config.type}`);
                    console.log(`  Default: ${formatValue(config.default)}`);
                    console.log(`  Per-Challenge: ${config.perChallenge ? 'Yes' : 'No'}`);
                    if (config.label) console.log(`  Label: ${config.label}`);
                    if (config.description) console.log(`  Description: ${config.description}`);
                });
                break;
            }

            case 'global-defaults': {
                // Show current global defaults for schema-based settings
                const allSettings = settings.loadSettings();
                const globalDefaults = allSettings.challengeSettings?.globalDefaults || {};

                console.log('Global Defaults for Schema Settings:');
                console.log('===================================');

                Object.entries(settings.SETTINGS_SCHEMA).forEach(([key, config]) => {
                    const currentValue = globalDefaults[key] !== undefined ? globalDefaults[key] : config.default;
                    console.log(`${key}: ${formatValue(currentValue)}`);
                });
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
                if (process.argv[3] !== 'yes') {
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
                console.log('  pnpm settings:get [key]             - Get setting value (all if no key)');
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
