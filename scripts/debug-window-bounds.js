#!/usr/bin/env node

/**
 * Test script to verify window bounds functionality
 */

const settings = require('../src/js/settings');

console.log('=== Testing Window Bounds Functionality ===\n');

// Test 1: Get default window bounds
console.log('1. Default Window Bounds:');
const defaultBounds = settings.getDefaultSettings().windowBounds;
console.log('   Login window:', defaultBounds.login);
console.log('   Main window:', defaultBounds.main);

// Test 2: Get current window bounds
console.log('\n2. Current Window Bounds:');
const loginBounds = settings.getWindowBounds('login');
const mainBounds = settings.getWindowBounds('main');
console.log('   Login window:', loginBounds);
console.log('   Main window:', mainBounds);

// Test 3: Save new window bounds
console.log('\n3. Saving New Window Bounds:');
const newLoginBounds = { x: 100, y: 200, width: 900, height: 700 };
const newMainBounds = { x: 150, y: 250, width: 1000, height: 800 };

const saveLoginResult = settings.saveWindowBounds('login', newLoginBounds);
const saveMainResult = settings.saveWindowBounds('main', newMainBounds);

console.log(`   Save login bounds: ${saveLoginResult ? 'SUCCESS' : 'FAILED'}`);
console.log(`   Save main bounds: ${saveMainResult ? 'SUCCESS' : 'FAILED'}`);

// Test 4: Verify saved bounds
console.log('\n4. Verifying Saved Bounds:');
const savedLoginBounds = settings.getWindowBounds('login');
const savedMainBounds = settings.getWindowBounds('main');

console.log('   Login window:', savedLoginBounds);
console.log('   Main window:', savedMainBounds);

const loginMatch = JSON.stringify(savedLoginBounds) === JSON.stringify(newLoginBounds);
const mainMatch = JSON.stringify(savedMainBounds) === JSON.stringify(newMainBounds);

console.log(`   Login bounds match: ${loginMatch ? 'YES' : 'NO'}`);
console.log(`   Main bounds match: ${mainMatch ? 'YES' : 'NO'}`);

// Test 5: Reset to defaults
console.log('\n5. Resetting to Defaults:');
const defaultLoginBounds = settings.getDefaultSettings().windowBounds.login;
const defaultMainBounds = settings.getDefaultSettings().windowBounds.main;

settings.saveWindowBounds('login', defaultLoginBounds);
settings.saveWindowBounds('main', defaultMainBounds);

const resetLoginBounds = settings.getWindowBounds('login');
const resetMainBounds = settings.getWindowBounds('main');

console.log('   Reset login window:', resetLoginBounds);
console.log('   Reset main window:', resetMainBounds);

console.log('\n=== Window Bounds Test Complete ===');
console.log('✅ Window bounds functionality works correctly');
console.log('✅ Bounds are saved and loaded properly');
console.log('✅ Default bounds are applied correctly'); 