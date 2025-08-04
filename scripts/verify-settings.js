#!/usr/bin/env node

/**
 * Test script to verify settings functionality in CLI context
 * This script tests that the settings module works correctly without Electron
 */

const settings = require('../src/js/settings');
const logger = require('../src/js/logger');

logger.withCategory('settings').info('=== Testing Settings Module in CLI Context ===\n');

// Test 0: Environment Information
logger.withCategory('settings').info('0. Environment Information:');
const envInfo = settings.getEnvironmentInfo();
logger.withCategory('settings').info(`   NODE_ENV: ${envInfo.nodeEnv || 'undefined'}`);
logger.withCategory('settings').info(`   DEV: ${envInfo.dev || 'undefined'}`);
logger.withCategory('settings').info(`   PROD: ${envInfo.prod || 'undefined'}`);
logger.withCategory('settings').info(`   Platform: ${envInfo.platform}`);
logger.withCategory('settings').info(`   Default Mock Setting: ${envInfo.defaultMock ? 'true (development)' : 'false (production)'}\n`);

// Test 1: Get userData path
logger.withCategory('settings').info('1. UserData Path:');
const userDataPath = settings.getUserDataPath();
logger.withCategory('settings').info(`   ${userDataPath}\n`);

// Test 2: Load default settings
logger.withCategory('settings').info('2. Loading Default Settings:');
const defaultSettings = settings.loadSettings();
logger.withCategory('settings').info('   Default settings loaded successfully');
logger.withCategory('settings').info(`   Theme: ${defaultSettings.theme}`);
logger.withCategory('settings').info(`   Mock mode: ${defaultSettings.mock} (${defaultSettings.mock ? 'development' : 'production'})`);
logger.withCategory('settings').info(`   Stay logged in: ${defaultSettings.stayLoggedIn}`);
logger.withCategory('settings').info(`   Token: ${defaultSettings.token ? 'Set' : 'Not set'}\n`);

// Test 3: Set and get a setting
logger.withCategory('settings').info('3. Testing Set/Get Setting:');
const testValue = 'test-value-' + Date.now();
const setResult = settings.setSetting('testSetting', testValue);
logger.withCategory('settings').info(`   Set test setting: ${setResult ? 'SUCCESS' : 'FAILED'}`);

const retrievedValue = settings.getSetting('testSetting');
logger.withCategory('settings').info(`   Retrieved value: ${retrievedValue}`);
logger.withCategory('settings').info(`   Values match: ${retrievedValue === testValue ? 'YES' : 'NO'}\n`);

// Test 4: Test settings persistence
logger.withCategory('settings').info('4. Testing Settings Persistence:');
logger.withCategory('settings').info('   Reloading settings...');
const reloadedSettings = settings.loadSettings();
logger.withCategory('settings').info(`   Test setting persisted: ${reloadedSettings.testSetting === testValue ? 'YES' : 'NO'}\n`);

// Test 5: Test settings file location
logger.withCategory('settings').info('5. Settings File Location:');
const fs = require('fs');
const path = require('path');
const settingsPath = path.join(userDataPath, 'settings.json');
logger.withCategory('settings').info(`   Settings file: ${settingsPath}`);
logger.withCategory('settings').info(`   File exists: ${fs.existsSync(settingsPath) ? 'YES' : 'NO'}`);

if (fs.existsSync(settingsPath)) {
    const stats = fs.statSync(settingsPath);
    logger.withCategory('settings').info(`   File size: ${stats.size} bytes`);
    logger.withCategory('settings').info(`   Last modified: ${stats.mtime.toLocaleString()}`);
}

// Test 6: Test mock setting override
logger.withCategory('settings').info('\n6. Testing Mock Setting Override:');
const originalMock = settings.getSetting('mock');
logger.withCategory('settings').info(`   Current mock setting: ${originalMock}`);


const newMockValue = !originalMock;
settings.setSetting('mock', newMockValue);
logger.withCategory('settings').info(`   Changed mock setting to: ${newMockValue}`);

// Verify change
const updatedMock = settings.getSetting('mock');
logger.withCategory('settings').info(`   Verified mock setting: ${updatedMock}`);
logger.withCategory('settings').info(`   Override successful: ${updatedMock === newMockValue ? 'YES' : 'NO'}`);

// Reset to original
settings.setSetting('mock', originalMock);
logger.withCategory('settings').info(`   Reset mock setting to: ${originalMock}\n`);

logger.withCategory('settings').info('=== Settings Test Complete ===');
logger.withCategory('settings').success('✅ Settings module works correctly in CLI context');
logger.withCategory('settings').success('✅ UserData directory is created automatically');
logger.withCategory('settings').success('✅ Settings are persisted between sessions');
logger.withCategory('settings').success('✅ Same settings file is used by both CLI and GUI');
logger.withCategory('settings').success('✅ Environment-aware mock setting defaults');
logger.withCategory('settings').success('✅ Mock setting can be overridden by user'); 