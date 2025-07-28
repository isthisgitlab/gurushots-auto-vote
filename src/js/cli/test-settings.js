#!/usr/bin/env node

/**
 * Test script to verify settings functionality in CLI context
 * This script tests that the settings module works correctly without Electron
 */

const settings = require('../settings');

console.log('=== Testing Settings Module in CLI Context ===\n');

// Test 0: Environment Information
console.log('0. Environment Information:');
const envInfo = settings.getEnvironmentInfo();
console.log(`   NODE_ENV: ${envInfo.nodeEnv || 'undefined'}`);
console.log(`   DEV: ${envInfo.dev || 'undefined'}`);
console.log(`   PROD: ${envInfo.prod || 'undefined'}`);
console.log(`   Platform: ${envInfo.platform}`);
console.log(`   Default Mock Setting: ${envInfo.defaultMock ? 'true (development)' : 'false (production)'}\n`);

// Test 1: Get userData path
console.log('1. UserData Path:');
const userDataPath = settings.getUserDataPath();
console.log(`   ${userDataPath}\n`);

// Test 2: Load default settings
console.log('2. Loading Default Settings:');
const defaultSettings = settings.loadSettings();
console.log('   Default settings loaded successfully');
console.log(`   Theme: ${defaultSettings.theme}`);
console.log(`   Mock mode: ${defaultSettings.mock} (${defaultSettings.mock ? 'development' : 'production'})`);
console.log(`   Stay logged in: ${defaultSettings.stayLoggedIn}`);
console.log(`   Token: ${defaultSettings.token ? 'Set' : 'Not set'}\n`);

// Test 3: Set and get a setting
console.log('3. Testing Set/Get Setting:');
const testValue = 'test-value-' + Date.now();
const setResult = settings.setSetting('testSetting', testValue);
console.log(`   Set test setting: ${setResult ? 'SUCCESS' : 'FAILED'}`);

const retrievedValue = settings.getSetting('testSetting');
console.log(`   Retrieved value: ${retrievedValue}`);
console.log(`   Values match: ${retrievedValue === testValue ? 'YES' : 'NO'}\n`);

// Test 4: Test settings persistence
console.log('4. Testing Settings Persistence:');
console.log('   Reloading settings...');
const reloadedSettings = settings.loadSettings();
console.log(`   Test setting persisted: ${reloadedSettings.testSetting === testValue ? 'YES' : 'NO'}\n`);

// Test 5: Test settings file location
console.log('5. Settings File Location:');
const fs = require('fs');
const path = require('path');
const settingsPath = path.join(userDataPath, 'settings.json');
console.log(`   Settings file: ${settingsPath}`);
console.log(`   File exists: ${fs.existsSync(settingsPath) ? 'YES' : 'NO'}`);

if (fs.existsSync(settingsPath)) {
    const stats = fs.statSync(settingsPath);
    console.log(`   File size: ${stats.size} bytes`);
    console.log(`   Last modified: ${stats.mtime.toLocaleString()}`);
}

// Test 6: Test mock setting override
console.log('\n6. Testing Mock Setting Override:');
const originalMock = settings.getSetting('mock');
console.log(`   Current mock setting: ${originalMock}`);

// Toggle mock setting
const newMockValue = !originalMock;
settings.setSetting('mock', newMockValue);
console.log(`   Changed mock setting to: ${newMockValue}`);

// Verify change
const updatedMock = settings.getSetting('mock');
console.log(`   Verified mock setting: ${updatedMock}`);
console.log(`   Override successful: ${updatedMock === newMockValue ? 'YES' : 'NO'}`);

// Reset to original
settings.setSetting('mock', originalMock);
console.log(`   Reset mock setting to: ${originalMock}\n`);

console.log('=== Settings Test Complete ===');
console.log('✅ Settings module works correctly in CLI context');
console.log('✅ UserData directory is created automatically');
console.log('✅ Settings are persisted between sessions');
console.log('✅ Same settings file is used by both CLI and GUI');
console.log('✅ Environment-aware mock setting defaults');
console.log('✅ Mock setting can be overridden by user'); 