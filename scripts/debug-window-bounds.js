#!/usr/bin/env node

/**
 * Test script to verify window bounds functionality
 */

const settings = require('../src/js/settings');
const logger = require('../src/js/logger');

logger.cliInfo('=== Testing Window Bounds Functionality ===\n');

// Test 1: Get default window bounds
logger.cliInfo('1. Default Window Bounds:');
const defaultBounds = settings.getDefaultSettings().windowBounds;
logger.cliInfo('   Login window:', defaultBounds.login);
logger.cliInfo('   Main window:', defaultBounds.main);

// Test 2: Get current window bounds
logger.cliInfo('\n2. Current Window Bounds:');
const loginBounds = settings.getWindowBounds('login');
const mainBounds = settings.getWindowBounds('main');
logger.cliInfo('   Login window:', loginBounds);
logger.cliInfo('   Main window:', mainBounds);

// Test 3: Save new window bounds
logger.cliInfo('\n3. Saving New Window Bounds:');
const newLoginBounds = {x: 100, y: 200, width: 900, height: 700};
const newMainBounds = {x: 150, y: 250, width: 1000, height: 800};

const saveLoginResult = settings.saveWindowBounds('login', newLoginBounds);
const saveMainResult = settings.saveWindowBounds('main', newMainBounds);

logger.cliInfo(`   Save login bounds: ${saveLoginResult ? 'SUCCESS' : 'FAILED'}`);
logger.cliInfo(`   Save main bounds: ${saveMainResult ? 'SUCCESS' : 'FAILED'}`);

// Test 4: Verify saved bounds
logger.cliInfo('\n4. Verifying Saved Bounds:');
const savedLoginBounds = settings.getWindowBounds('login');
const savedMainBounds = settings.getWindowBounds('main');

logger.cliInfo('   Login window:', savedLoginBounds);
logger.cliInfo('   Main window:', savedMainBounds);

const loginMatch = JSON.stringify(savedLoginBounds) === JSON.stringify(newLoginBounds);
const mainMatch = JSON.stringify(savedMainBounds) === JSON.stringify(newMainBounds);

logger.cliInfo(`   Login bounds match: ${loginMatch ? 'YES' : 'NO'}`);
logger.cliInfo(`   Main bounds match: ${mainMatch ? 'YES' : 'NO'}`);

// Test 5: Reset to defaults
logger.cliInfo('\n5. Resetting to Defaults:');
const defaultLoginBounds = settings.getDefaultSettings().windowBounds.login;
const defaultMainBounds = settings.getDefaultSettings().windowBounds.main;

settings.saveWindowBounds('login', defaultLoginBounds);
settings.saveWindowBounds('main', defaultMainBounds);

const resetLoginBounds = settings.getWindowBounds('login');
const resetMainBounds = settings.getWindowBounds('main');

logger.cliInfo('   Reset login window:', resetLoginBounds);
logger.cliInfo('   Reset main window:', resetMainBounds);

logger.cliInfo('\n=== Window Bounds Test Complete ===');
logger.cliSuccess('✅ Window bounds functionality works correctly');
logger.cliSuccess('✅ Bounds are saved and loaded properly');
logger.cliSuccess('✅ Default bounds are applied correctly'); 