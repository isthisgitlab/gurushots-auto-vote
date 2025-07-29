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

        // Check version number
        const expectedVersion = `**Latest Version: v${version}`;
        if (!content.includes(expectedVersion)) {
            issues.push(`Version number should be "${expectedVersion}"`);
        }

        // Check file names
        const expectedFiles = [
            `GuruShotsAutoVote-v${version}-x64.exe`,
            `GuruShotsAutoVote-v${version}-arm64.dmg`,
            `GuruShotsAutoVote-v${version}-x86_64.AppImage`,
            `GuruShotsAutoVote-v${version}-arm64.AppImage`,
        ];

        expectedFiles.forEach(file => {
            if (!content.includes(file)) {
                issues.push(`Missing file reference: ${file}`);
            }
        });

        // Check URLs
        const expectedUrls = [
            `https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/GuruShotsAutoVote-v${version}-x64.exe`,
            `https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/GuruShotsAutoVote-v${version}-arm64.dmg`,
            `https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/GuruShotsAutoVote-v${version}-x86_64.AppImage`,
            `https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/GuruShotsAutoVote-v${version}-arm64.AppImage`,
        ];

        expectedUrls.forEach(url => {
            if (!content.includes(url)) {
                issues.push(`Missing URL: ${url}`);
            }
        });

        // Check command examples
        const expectedCommands = [
            `chmod +x GuruShotsAutoVote-v${version}-*.AppImage`,
            `./GuruShotsAutoVote-v${version}-*.AppImage`,
        ];

        expectedCommands.forEach(cmd => {
            if (!content.includes(cmd)) {
                issues.push(`Missing command example: ${cmd}`);
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