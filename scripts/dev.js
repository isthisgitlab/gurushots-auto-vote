const {spawn} = require('child_process');

// Start nodemon
const nodemon = spawn('npx', ['nodemon'], {
    stdio: 'inherit',
    cwd: process.cwd(),
});

// Function to check if Electron process is running
function isElectronRunning() {
    return new Promise((resolve) => {
        const {exec} = require('child_process');
        if (process.platform === 'win32') {
            exec('tasklist /fi "imagename eq electron.exe"', (error, stdout) => {
                resolve(!error && stdout.includes('electron.exe'));
            });
        } else {
            exec('pgrep -f "electron ."', (error, stdout) => {
                resolve(!error && stdout.trim() !== '');
            });
        }
    });
}

// Check every second if Electron is still running
const checkInterval = setInterval(async () => {
    const isRunning = await isElectronRunning();
    if (!isRunning) {
        console.log('Electron process not found, killing nodemon...');
        clearInterval(checkInterval);
        nodemon.kill('SIGTERM');
        setTimeout(() => {
            process.exit(0);
        }, 1000);
    }
}, 1000);

// Handle process termination
process.on('SIGINT', () => {
    clearInterval(checkInterval);
    nodemon.kill('SIGTERM');
    process.exit(0);
});

process.on('SIGTERM', () => {
    clearInterval(checkInterval);
    nodemon.kill('SIGTERM');
    process.exit(0);
});

// When nodemon exits, exit this process too
nodemon.on('exit', (code) => {
    clearInterval(checkInterval);
    process.exit(code);
}); 