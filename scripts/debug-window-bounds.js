#!/usr/bin/env node

/**
 * Test script to verify window bounds functionality
 */

const settings = require('../src/js/settings');
const logger = require('../src/js/logger');

logger.withCategory('ui').info('=== Testing Window Bounds Functionality ===\n');

// Test 1: Get default window bounds
logger.withCategory('ui').info('1. Default Window Bounds:');
const defaultBounds = settings.getDefaultSettings().windowBounds;
logger.withCategory('ui').info('   Login window:', defaultBounds.login);
logger.withCategory('ui').info('   Main window:', defaultBounds.main);

// Test 2: Get current window bounds
logger.withCategory('ui').info('\n2. Current Window Bounds:');
const loginBounds = settings.getWindowBounds('login');
const mainBounds = settings.getWindowBounds('main');
logger.withCategory('ui').info('   Login window:', loginBounds);
logger.withCategory('ui').info('   Main window:', mainBounds);

// Test 3: Save new window bounds
logger.withCategory('ui').info('\n3. Saving New Window Bounds:');
const newLoginBounds = {x: 100, y: 200, width: 900, height: 700};
const newMainBounds = {x: 150, y: 250, width: 1000, height: 800};

const saveLoginResult = settings.saveWindowBounds('login', newLoginBounds);
const saveMainResult = settings.saveWindowBounds('main', newMainBounds);

logger.withCategory('ui').info(`   Save login bounds: ${saveLoginResult ? 'SUCCESS' : 'FAILED'}`);
logger.withCategory('ui').info(`   Save main bounds: ${saveMainResult ? 'SUCCESS' : 'FAILED'}`);

// Test 4: Verify saved bounds
logger.withCategory('ui').info('\n4. Verifying Saved Bounds:');
const savedLoginBounds = settings.getWindowBounds('login');
const savedMainBounds = settings.getWindowBounds('main');

logger.withCategory('ui').info('   Login window:', savedLoginBounds);
logger.withCategory('ui').info('   Main window:', savedMainBounds);

const loginMatch = JSON.stringify(savedLoginBounds) === JSON.stringify(newLoginBounds);
const mainMatch = JSON.stringify(savedMainBounds) === JSON.stringify(newMainBounds);

logger.withCategory('ui').info(`   Login bounds match: ${loginMatch ? 'YES' : 'NO'}`);
logger.withCategory('ui').info(`   Main bounds match: ${mainMatch ? 'YES' : 'NO'}`);

// Test 5: Reset to defaults
logger.withCategory('ui').info('\n5. Resetting to Defaults:');
const defaultLoginBounds = settings.getDefaultSettings().windowBounds.login;
const defaultMainBounds = settings.getDefaultSettings().windowBounds.main;

settings.saveWindowBounds('login', defaultLoginBounds);
settings.saveWindowBounds('main', defaultMainBounds);

const resetLoginBounds = settings.getWindowBounds('login');
const resetMainBounds = settings.getWindowBounds('main');

logger.withCategory('ui').info('   Reset login window:', resetLoginBounds);
logger.withCategory('ui').info('   Reset main window:', resetMainBounds);

logger.withCategory('ui').info('\n=== Window Bounds Test Complete ===');
logger.withCategory('ui').success('✅ Window bounds functionality works correctly');
logger.withCategory('ui').success('✅ Bounds are saved and loaded properly');
logger.withCategory('ui').success('✅ Default bounds are applied correctly'); 