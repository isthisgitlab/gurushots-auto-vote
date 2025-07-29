#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const os = require('os');

// Get the same userData path that settings use
const getUserDataPath = () => {
    const appName = 'gurushots-auto-vote';

    // Use platform-specific paths
    switch (process.platform) {
    case 'darwin': // macOS
        return path.join(os.homedir(), 'Library', 'Application Support', appName);
    case 'win32': // Windows
        return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), appName);
    default: // Linux and others
        return path.join(os.homedir(), '.config', appName);
    }
};

const logsDir = path.join(getUserDataPath(), 'logs');

console.log('🧹 Cleaning up old log files...');
console.log(`📁 Logs directory: ${logsDir}`);

if (!fs.existsSync(logsDir)) {
    console.log('✅ No logs directory found, nothing to clean up.');
    process.exit(0);
}

try {
    const files = fs.readdirSync(logsDir);
    let deletedCount = 0;
    let totalSize = 0;

    files.forEach(file => {
        // Clean up old timestamped files
        if (file.startsWith('api-debug-')) {
            const filePath = path.join(logsDir, file);
            const stats = fs.statSync(filePath);

            console.log(`🗑️  Deleting old log file: ${file} (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);

            fs.unlinkSync(filePath);
            deletedCount++;
            totalSize += stats.size;
        }
    });

    if (deletedCount > 0) {
        console.log(`✅ Cleaned up ${deletedCount} old log files`);
        console.log(`💾 Freed up ${(totalSize / 1024 / 1024).toFixed(2)} MB of disk space`);
    } else {
        console.log('✅ No old log files found to clean up');
    }

    console.log('\n📋 Current logging structure:');
    console.log('   • errors-YYYY-MM-DD.log - Error logs (30 days retention)');
    console.log('   • app-YYYY-MM-DD.log - General application logs (7 days retention)');
    console.log('   • api-YYYY-MM-DD.log - API request/response logs (dev mode only, 1 day retention)');
    console.log('\n🔄 Automatic cleanup:');
    console.log('   • Runs on application startup');
    console.log('   • Runs every hour while application is running');
    console.log('   • Deletes files based on date and size limits');

} catch (error) {
    console.error('❌ Error during cleanup:', error);
    process.exit(1);
} 