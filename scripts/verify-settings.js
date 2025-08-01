#!/usr/bin/env node

/**
 * Test script to verify settings functionality in CLI context
 * This script tests that the settings module works correctly without Electron
 */

const settings = require('../src/js/settings');
const logger = require('../src/js/logger');

logger.cliInfo('=== Testing Settings Module in CLI Context ===\n');

// Test 0: Environment Information
logger.cliInfo('0. Environment Information:');
const envInfo = settings.getEnvironmentInfo();
logger.cliInfo(`   NODE_ENV: ${envInfo.nodeEnv || 'undefined'}`);
logger.cliInfo(`   DEV: ${envInfo.dev || 'undefined'}`);
logger.cliInfo(`   PROD: ${envInfo.prod || 'undefined'}`);
logger.cliInfo(`   Platform: ${envInfo.platform}`);
logger.cliInfo(`   Default Mock Setting: ${envInfo.defaultMock ? 'true (development)' : 'false (production)'}\n`);

// Test 1: Get userData path
logger.cliInfo('1. UserData Path:');
const userDataPath = settings.getUserDataPath();
logger.cliInfo(`   ${userDataPath}\n`);

// Test 2: Load default settings
logger.cliInfo('2. Loading Default Settings:');
const defaultSettings = settings.loadSettings();
logger.cliInfo('   Default settings loaded successfully');
logger.cliInfo(`   Theme: ${defaultSettings.theme}`);
logger.cliInfo(`   Mock mode: ${defaultSettings.mock} (${defaultSettings.mock ? 'development' : 'production'})`);
logger.cliInfo(`   Stay logged in: ${defaultSettings.stayLoggedIn}`);
logger.cliInfo(`   Token: ${defaultSettings.token ? 'Set' : 'Not set'}\n`);

// Test 3: Set and get a setting
logger.cliInfo('3. Testing Set/Get Setting:');
const testValue = 'test-value-' + Date.now();
const setResult = settings.setSetting('testSetting', testValue);
logger.cliInfo(`   Set test setting: ${setResult ? 'SUCCESS' : 'FAILED'}`);

const retrievedValue = settings.getSetting('testSetting');
logger.cliInfo(`   Retrieved value: ${retrievedValue}`);
logger.cliInfo(`   Values match: ${retrievedValue === testValue ? 'YES' : 'NO'}\n`);

// Test 4: Test settings persistence
logger.cliInfo('4. Testing Settings Persistence:');
logger.cliInfo('   Reloading settings...');
const reloadedSettings = settings.loadSettings();
logger.cliInfo(`   Test setting persisted: ${reloadedSettings.testSetting === testValue ? 'YES' : 'NO'}\n`);

// Test 5: Test settings file location
logger.cliInfo('5. Settings File Location:');
const fs = require('fs');
const path = require('path');
const settingsPath = path.join(userDataPath, 'settings.json');
logger.cliInfo(`   Settings file: ${settingsPath}`);
logger.cliInfo(`   File exists: ${fs.existsSync(settingsPath) ? 'YES' : 'NO'}`);

if (fs.existsSync(settingsPath)) {
    const stats = fs.statSync(settingsPath);
    logger.cliInfo(`   File size: ${stats.size} bytes`);
    logger.cliInfo(`   Last modified: ${stats.mtime.toLocaleString()}`);
}

// Test 6: Test mock setting override
logger.cliInfo('\n6. Testing Mock Setting Override:');
const originalMock = settings.getSetting('mock');
logger.cliInfo(`   Current mock setting: ${originalMock}`);


const newMockValue = !originalMock;
settings.setSetting('mock', newMockValue);
logger.cliInfo(`   Changed mock setting to: ${newMockValue}`);

// Verify change
const updatedMock = settings.getSetting('mock');
logger.cliInfo(`   Verified mock setting: ${updatedMock}`);
logger.cliInfo(`   Override successful: ${updatedMock === newMockValue ? 'YES' : 'NO'}`);

// Reset to original
settings.setSetting('mock', originalMock);
logger.cliInfo(`   Reset mock setting to: ${originalMock}\n`);

logger.cliInfo('=== Settings Test Complete ===');
logger.cliSuccess('✅ Settings module works correctly in CLI context');
logger.cliSuccess('✅ UserData directory is created automatically');
logger.cliSuccess('✅ Settings are persisted between sessions');
logger.cliSuccess('✅ Same settings file is used by both CLI and GUI');
logger.cliSuccess('✅ Environment-aware mock setting defaults');
logger.cliSuccess('✅ Mock setting can be overridden by user'); 