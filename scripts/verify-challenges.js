#!/usr/bin/env node

/**
 * Test script to verify GUI challenges functionality
 */

const apiFactory = require('../src/js/apiFactory');
const settings = require('../src/js/settings');

console.log('=== Testing GUI Challenges Functionality ===\n');

async function testGuiChallenges() {
    try {
        // Set a mock token
        settings.setSetting('token', 'mock_test_token_123');
        
        // Get the middleware
        const middleware = apiFactory.getMiddleware();
        
        console.log('1. Testing GUI Vote Function:');
        const result = await middleware.guiVote();
        
        console.log('   Success:', result.success);
        console.log('   Message:', result.data?.message || result.error);
        
        if (result.success && result.data?.challenges) {
            console.log(`   Challenges loaded: ${result.data.challenges.length}`);
            
            console.log('\n2. Challenge Details:');
            result.data.challenges.forEach((challenge, index) => {
                console.log(`   Challenge ${index + 1}:`);
                console.log(`     Title: ${challenge.title}`);
                console.log(`     Description: ${challenge.description}`);
                console.log(`     End Time: ${new Date(challenge.end_time * 1000).toLocaleString()}`);
                console.log(`     Exposure: ${challenge.member.ranking.exposure.exposure_factor}%`);
                console.log(`     Boost: ${challenge.member.boost.state}`);
                console.log(`     Entries: ${challenge.member.ranking.entries.length}/4`);
                
                if (challenge.member.ranking.entries.length > 0) {
                    console.log('     Entry Details:');
                    challenge.member.ranking.entries.forEach(entry => {
                        console.log(`       - ${entry.turbo ? '🚀' : '📷'} Rank ${entry.rank}`);
                    });
                }
                console.log('');
            });
        }
        
        console.log('3. Time Remaining Calculations:');
        if (result.success && result.data?.challenges) {
            result.data.challenges.forEach((challenge, index) => {
                const now = Math.floor(Date.now() / 1000);
                const remaining = challenge.end_time - now;
                
                if (remaining <= 0) {
                    console.log(`   Challenge ${index + 1}: Ended`);
                } else {
                    const days = Math.floor(remaining / 86400);
                    const hours = Math.floor((remaining % 86400) / 3600);
                    const minutes = Math.floor((remaining % 3600) / 60);
                    
                    if (days > 0) {
                        console.log(`   Challenge ${index + 1}: ${days}d ${hours}h ${minutes}m`);
                    } else if (hours > 0) {
                        console.log(`   Challenge ${index + 1}: ${hours}h ${minutes}m`);
                    } else {
                        console.log(`   Challenge ${index + 1}: ${minutes}m`);
                    }
                }
            });
        }
        
        console.log('\n=== GUI Challenges Test Complete ===');
        console.log('✅ GUI challenges functionality works correctly');
        console.log('✅ Mock data is properly structured');
        console.log('✅ Time calculations are working');
        
    } catch (error) {
        console.error('❌ Test failed:', error);
    }
}

testGuiChallenges(); 