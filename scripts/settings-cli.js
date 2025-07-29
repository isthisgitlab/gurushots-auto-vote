#!/usr/bin/env node

const settings = require('../src/js/settings');
const {spawn} = require('child_process');

/**
 * CLI Settings Management Script
 *
 * Usage:
 *   npm run settings:get [key]     - Get setting value (or all if no key provided)
 *   npm run settings:set key value - Set setting value
 *
 * Examples:
 *   npm run settings:get            # Get all settings
 *   npm run settings:get theme      # Get theme setting
 *   npm run settings:set theme dark # Set theme to dark
 *   npm run settings:set challengeSettings.globalDefaults.boostTime 7200
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

    // Try to parse value as JSON first, then number, then boolean, then string
    let parsedValue = value;
    try {
        parsedValue = JSON.parse(value);
    } catch {
        if (!isNaN(value) && !isNaN(parseFloat(value))) {
            parsedValue = parseFloat(value);
        } else if (value === 'true' || value === 'false') {
            parsedValue = value === 'true';
        }
    }

    target[lastKey] = parsedValue;
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
        return '[' + value.map(v => JSON.stringify(v)).join(', ') + ']';
    }

    return JSON.stringify(value);
}

// Function to check if Electron GUI is running
function isElectronRunning() {
    return new Promise((resolve) => {
        const process = spawn('pgrep', ['-f', 'electron.*gurushots-auto-vote'], {stdio: 'pipe'});

        process.on('close', (code) => {
            resolve(code === 0);
        });

        process.on('error', () => {
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
                console.error('Usage: npm run settings:set <key> <value>');
                console.error('Example: npm run settings:set theme dark');
                process.exit(1);
            }

            const allSettings = settings.loadSettings();

            // Handle nested keys by modifying the settings object
            if (key.includes('.')) {
                setNestedProperty(allSettings, key, value);
                const success = settings.saveSettings(allSettings);
                if (success) {
                    console.log(`✅ Set ${key} = ${formatValue(getNestedProperty(allSettings, key))}`);

                    // Inform about GUI reload for certain settings
                    const uiSettings = ['theme', 'language', 'timezone'];
                    const mainKey = key.split('.')[0];
                    if (uiSettings.includes(mainKey) || key.includes('theme') || key.includes('language') || key.includes('timezone')) {
                        await informAboutGuiReload();
                    }
                } else {
                    console.error(`❌ Failed to save setting '${key}'`);
                    process.exit(1);
                }
            } else {
                // Handle top-level settings
                let parsedValue = value;

                // Try to parse value appropriately
                try {
                    parsedValue = JSON.parse(value);
                } catch {
                    if (!isNaN(value) && !isNaN(parseFloat(value))) {
                        parsedValue = parseFloat(value);
                    } else if (value === 'true' || value === 'false') {
                        parsedValue = value === 'true';
                    }
                }

                const success = settings.setSetting(key, parsedValue);
                if (success) {
                    console.log(`✅ Set ${key} = ${formatValue(parsedValue)}`);

                    // Inform about GUI reload for certain settings
                    const uiSettings = ['theme', 'language', 'timezone'];
                    if (uiSettings.includes(key)) {
                        await informAboutGuiReload();
                    }
                } else {
                    console.error(`❌ Failed to save setting '${key}'`);
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

        case 'help':
        default: {
            console.log('Settings CLI Help');
            console.log('================');
            console.log('');
            console.log('Available commands:');
            console.log('  npm run settings:get [key]        - Get setting value (all if no key)');
            console.log('  npm run settings:set <key> <value> - Set setting value');
            console.log('  npm run settings:schema            - Show settings schema');
            console.log('  npm run settings:global-defaults   - Show global defaults');
            console.log('  npm run settings:help              - Show this help');
            console.log('  npm run gui:refresh                - Get info about refreshing GUI');
            console.log('');
            console.log('Examples:');
            console.log('  npm run settings:get');
            console.log('  npm run settings:get theme');
            console.log('  npm run settings:set theme dark');
            console.log('  npm run settings:set stayLoggedIn true');
            console.log('  npm run settings:set challengeSettings.globalDefaults.boostTime 7200');
            console.log('');
            console.log('Notes:');
            console.log('  - Values are automatically parsed (JSON, numbers, booleans)');
            console.log('  - Use dot notation for nested properties');
            console.log('  - CLI only supports global settings, not per-challenge overrides');
            console.log('  - GUI refresh (Ctrl+R / Cmd+R) needed for theme/language/timezone changes');
            break;
        }
        }
    } catch (error) {
        console.error('❌ Error:', error.message);
        process.exit(1);
    }
}

main();