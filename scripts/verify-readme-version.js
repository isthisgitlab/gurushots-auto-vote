#!/usr/bin/env node

/**
 * Verify README.md version matches package.json
 * This script checks if the README.md file has the correct version numbers
 * and download links matching the current package.json version.
 */

const fs = require('fs');
const path = require('path');

try {
    // Get version from package.json
    const packageJsonPath = path.join(__dirname, '..', 'package.json');
    if (!fs.existsSync(packageJsonPath)) {
        throw new Error('package.json not found');
    }

    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    const version = packageJson.version;

    if (!version) {
        throw new Error('No version found in package.json');
    }

    console.log(`Verifying documentation matches version ${version}...`);

    // Files to verify
    const filesToVerify = [
        {
            path: path.join(__dirname, '..', 'README.md'),
            name: 'README.md',
        },
        {
            path: path.join(__dirname, '..', 'docs', 'INSTALACIJA.md'),
            name: 'docs/INSTALACIJA.md',
        },
    ];

    let allIssues = [];

    filesToVerify.forEach(fileInfo => {
        if (!fs.existsSync(fileInfo.path)) {
            console.log(`⚠️  ${fileInfo.name} not found, skipping...`);
            return;
        }

        const content = fs.readFileSync(fileInfo.path, 'utf8');
        let issues = [];

        // Check version number using regex
        const versionPattern = /\*\*Latest Version: v([\d.]+(?:-[a-zA-Z0-9.]+)?)/;
        const versionMatch = content.match(versionPattern);
        if (!versionMatch) {
            issues.push(`Missing version number. Expected format: "**Latest Version: v${version}"`);
        } else if (versionMatch[1] !== version) {
            issues.push(`Version mismatch. Found v${versionMatch[1]}, expected v${version}`);
        }

        // Determine if this file has CLI section
        const hasCLISection = content.includes('gurucli-v') || content.includes('CLI Applications');

        // Check file names using regex patterns
        const filePatterns = [
            { pattern: /GuruShotsAutoVote-v[\d.]+(?:-[a-zA-Z0-9.]+)?-x64\.exe/g, type: 'GuruShotsAutoVote-x64.exe', required: true },
            { pattern: /GuruShotsAutoVote-v[\d.]+(?:-[a-zA-Z0-9.]+)?-arm64\.dmg/g, type: 'GuruShotsAutoVote-arm64.dmg', required: true },
            { pattern: /GuruShotsAutoVote-v[\d.]+(?:-[a-zA-Z0-9.]+)?-arm64\.app\.zip/g, type: 'GuruShotsAutoVote-arm64.app.zip', required: true },
            { pattern: /GuruShotsAutoVote-v[\d.]+(?:-[a-zA-Z0-9.]+)?-x86_64\.AppImage/g, type: 'GuruShotsAutoVote-x86_64.AppImage', required: true },
            { pattern: /GuruShotsAutoVote-v[\d.]+(?:-[a-zA-Z0-9.]+)?-arm64\.AppImage/g, type: 'GuruShotsAutoVote-arm64.AppImage', required: true },
            // CLI files - only required if CLI section exists
            { pattern: /gurucli-v[\d.]+(?:-[a-zA-Z0-9.]+)?-mac/g, type: 'gurucli-mac', required: hasCLISection },
            { pattern: /gurucli-v[\d.]+(?:-[a-zA-Z0-9.]+)?-linux/g, type: 'gurucli-linux', required: hasCLISection },
            { pattern: /gurucli-v[\d.]+(?:-[a-zA-Z0-9.]+)?-linux-arm/g, type: 'gurucli-linux-arm', required: hasCLISection },
        ];

        filePatterns.forEach(({ pattern, type, required }) => {
            if (!required) return; // Skip if not required for this file
            
            const matches = content.match(pattern);
            if (!matches) {
                issues.push(`Missing file reference: ${type} with version ${version}`);
            } else {
                // Check if any of the matches has the correct version
                const hasCorrectVersion = matches.some(match => match.includes(`-v${version}-`) || match.includes(`-v${version}`));
                if (!hasCorrectVersion) {
                    issues.push(`Missing file reference: ${type} with version ${version}`);
                }
            }
        });

        // Check URLs using regex patterns
        const urlPatterns = [
            { pattern: /https:\/\/github\.com\/isthisgitlab\/gurushots-auto-vote\/releases\/latest\/download\/GuruShotsAutoVote-v[\d.]+(?:-[a-zA-Z0-9.]+)?-x64\.exe/g, type: 'GuruShotsAutoVote-x64.exe URL', required: true },
            { pattern: /https:\/\/github\.com\/isthisgitlab\/gurushots-auto-vote\/releases\/latest\/download\/GuruShotsAutoVote-v[\d.]+(?:-[a-zA-Z0-9.]+)?-arm64\.dmg/g, type: 'GuruShotsAutoVote-arm64.dmg URL', required: true },
            { pattern: /https:\/\/github\.com\/isthisgitlab\/gurushots-auto-vote\/releases\/latest\/download\/GuruShotsAutoVote-v[\d.]+(?:-[a-zA-Z0-9.]+)?-arm64\.app\.zip/g, type: 'GuruShotsAutoVote-arm64.app.zip URL', required: true },
            { pattern: /https:\/\/github\.com\/isthisgitlab\/gurushots-auto-vote\/releases\/latest\/download\/GuruShotsAutoVote-v[\d.]+(?:-[a-zA-Z0-9.]+)?-x86_64\.AppImage/g, type: 'GuruShotsAutoVote-x86_64.AppImage URL', required: true },
            { pattern: /https:\/\/github\.com\/isthisgitlab\/gurushots-auto-vote\/releases\/latest\/download\/GuruShotsAutoVote-v[\d.]+(?:-[a-zA-Z0-9.]+)?-arm64\.AppImage/g, type: 'GuruShotsAutoVote-arm64.AppImage URL', required: true },
            // CLI URLs - only required if CLI section exists
            { pattern: /https:\/\/github\.com\/isthisgitlab\/gurushots-auto-vote\/releases\/latest\/download\/gurucli-v[\d.]+(?:-[a-zA-Z0-9.]+)?-mac/g, type: 'gurucli-mac URL', required: hasCLISection },
            { pattern: /https:\/\/github\.com\/isthisgitlab\/gurushots-auto-vote\/releases\/latest\/download\/gurucli-v[\d.]+(?:-[a-zA-Z0-9.]+)?-linux/g, type: 'gurucli-linux URL', required: hasCLISection },
            { pattern: /https:\/\/github\.com\/isthisgitlab\/gurushots-auto-vote\/releases\/latest\/download\/gurucli-v[\d.]+(?:-[a-zA-Z0-9.]+)?-linux-arm/g, type: 'gurucli-linux-arm URL', required: hasCLISection },
        ];

        urlPatterns.forEach(({ pattern, type, required }) => {
            if (!required) return; // Skip if not required for this file
            
            const matches = content.match(pattern);
            if (!matches) {
                issues.push(`Missing URL: ${type} with version ${version}`);
            } else {
                // Check if any of the matches has the correct version
                const hasCorrectVersion = matches.some(match => match.includes(`-v${version}-`) || match.includes(`-v${version}`));
                if (!hasCorrectVersion) {
                    issues.push(`Missing URL: ${type} with version ${version}`);
                }
            }
        });

        // Check command examples using regex patterns
        const commandPatterns = [
            { pattern: /chmod \+x GuruShotsAutoVote-v[\d.]+(?:-[a-zA-Z0-9.]+)?-\*\.AppImage/g, type: 'chmod AppImage', required: content.includes('AppImage') },
            { pattern: /\.\/GuruShotsAutoVote-v[\d.]+(?:-[a-zA-Z0-9.]+)?-\*\.AppImage/g, type: 'run AppImage', required: content.includes('AppImage') },
            // CLI command examples - only required if CLI section exists
            { pattern: /chmod \+x gurucli-v[\d.]+(?:-[a-zA-Z0-9.]+)?-mac/g, type: 'chmod gurucli-mac', required: hasCLISection && content.includes('gurucli-mac') },
            { pattern: /\.\/gurucli-v[\d.]+(?:-[a-zA-Z0-9.]+)?-mac/g, type: 'run gurucli-mac', required: hasCLISection && content.includes('gurucli-mac') },
            { pattern: /chmod \+x gurucli-v[\d.]+(?:-[a-zA-Z0-9.]+)?-linux/g, type: 'chmod gurucli-linux', required: hasCLISection && content.includes('gurucli-linux') },
            { pattern: /\.\/gurucli-v[\d.]+(?:-[a-zA-Z0-9.]+)?-linux/g, type: 'run gurucli-linux', required: hasCLISection && content.includes('gurucli-linux') },
        ];

        commandPatterns.forEach(({ pattern, type, required }) => {
            if (!required) return; // Skip if not required for this file
            
            const matches = content.match(pattern);
            if (!matches) {
                issues.push(`Missing command example: ${type} with version ${version}`);
            } else {
                // Check if any of the matches has the correct version
                const hasCorrectVersion = matches.some(match => match.includes(`-v${version}`));
                if (!hasCorrectVersion) {
                    issues.push(`Missing command example: ${type} with version ${version}`);
                }
            }
        });

        if (issues.length > 0) {
            allIssues.push({
                file: fileInfo.name,
                issues: issues,
            });
        } else {
            console.log(`✅ ${fileInfo.name} is up to date with package.json version`);
        }
    });

    if (allIssues.length > 0) {
        console.error('❌ Documentation is out of sync with package.json version:');
        allIssues.forEach(fileIssue => {
            console.error(`\n📄 ${fileIssue.file}:`);
            fileIssue.issues.forEach(issue => console.error(`   - ${issue}`));
        });
        console.error('\n💡 Run "npm run update:readme" to fix these issues.');
        process.exit(1);
    } else {
        console.log('✅ All documentation is up to date with package.json version');
    }

} catch (error) {
    console.error(`❌ Error verifying documentation: ${error.message}`);
    process.exit(1);
} 