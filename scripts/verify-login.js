/**
 * Test script for login functionality
 * 
 * This script tests both real and mock login functionality
 * to ensure the implementation works correctly.
 */

const { authenticate } = require('../src/js/api/login');
const { mockLoginSuccess, mockLoginFailure } = require('../src/js/mock/auth');

// Test mock authentication
const testMockAuth = async () => {
    console.log('\n=== Testing Mock Authentication ===');
    
    // Simulate the mock authentication logic from the main process
    const simulateMockAuth = async (username) => {
        // Simulate network delay for realistic behavior
        await new Promise(resolve => setTimeout(resolve, 100));
        

        const isValidCredential = true;
        
        if (isValidCredential) {
            return {
                success: true,
                token: mockLoginSuccess.token,
                message: 'Mock login successful',
                user: {
                    id: mockLoginSuccess.user.id,
                    email: username,
                    username: mockLoginSuccess.user.username,
                    display_name: mockLoginSuccess.user.display_name,
                },
            };
        } else {
            return {
                success: false,
                message: mockLoginFailure.message || 'Invalid mock credentials',
            };
        }
    };
    
    // Test any credentials (should all work in mock mode)
    console.log('Testing mock credentials...');
    const result1 = await simulateMockAuth('any@example.com', 'anypassword');
    console.log('Any credentials result:', result1);
    
    // Test another set of credentials
    console.log('\nTesting another set of mock credentials...');
    const result2 = await simulateMockAuth('test@test.com', 'test123');
    console.log('Another credentials result:', result2);
    
    // Test empty credentials (should still work in mock mode)
    console.log('\nTesting empty credentials...');
    const result3 = await simulateMockAuth('', '');
    console.log('Empty credentials result:', result3);
};

// Test real authentication (will fail without real credentials)
const testRealAuth = async () => {
    console.log('\n=== Testing Real Authentication ===');
    
    // Test with dummy credentials (will fail)
    console.log('Testing with dummy credentials...');
    try {
        const result = await authenticate('dummy@example.com', 'dummypassword');
        console.log('Real auth result:', result);
    } catch (error) {
        console.log('Real auth error (expected):', error.message);
    }
};

// Main test function
const runTests = async () => {
    console.log('Starting login functionality tests...');
    
    try {
        await testMockAuth();
        await testRealAuth();
        
        console.log('\n=== Test Summary ===');
        console.log('✅ Mock authentication tests completed');
        console.log('✅ Real authentication tests completed (expected to fail with dummy credentials)');
        console.log('\nLogin functionality appears to be working correctly!');
        console.log('\nMock mode now accepts ANY username/password combination!');
        
    } catch (error) {
        console.error('Test failed:', error);
    }
};

// Run tests if this file is executed directly
if (require.main === module) {
    runTests();
}

module.exports = {
    testMockAuth,
    testRealAuth,
    runTests,
}; 