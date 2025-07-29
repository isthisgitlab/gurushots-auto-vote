#!/usr/bin/env node

/**
 * Update README.md with current version information
 * This script updates the download links and version numbers in README.md
 * to match the current package.json version.
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

    console.log(`Updating documentation with version ${version}...`);

    // Files to update
    const filesToUpdate = [
        {
            path: path.join(__dirname, '..', 'README.md'),
            name: 'README.md',
        },
        {
            path: path.join(__dirname, '..', 'docs', 'INSTALACIJA.md'),
            name: 'docs/INSTALACIJA.md',
        },
    ];

    let totalChanges = 0;

    filesToUpdate.forEach(fileInfo => {
        if (!fs.existsSync(fileInfo.path)) {
            console.log(`⚠️  ${fileInfo.name} not found, skipping...`);
            return;
        }

        let content = fs.readFileSync(fileInfo.path, 'utf8');
        let changesMade = 0;

        // Update the version number in the download section
        const versionPattern = /\*\*Latest Version: v[\d.]+/g;
        if (versionPattern.test(content)) {
            content = content.replace(versionPattern, `**Latest Version: v${version}`);
            changesMade++;
        }

        // Update all download links with the current version
        const filePatterns = [
            {
                pattern: /GuruShotsAutoVote-v[\d.]+-x64\.exe/g,
                replacement: `GuruShotsAutoVote-v${version}-x64.exe`,
            },
            {
                pattern: /GuruShotsAutoVote-v[\d.]+-arm64\.dmg/g,
                replacement: `GuruShotsAutoVote-v${version}-arm64.dmg`,
            },
            {
                pattern: /GuruShotsAutoVote-v[\d.]+-x86_64\.AppImage/g,
                replacement: `GuruShotsAutoVote-v${version}-x86_64.AppImage`,
            },
            {
                pattern: /GuruShotsAutoVote-v[\d.]+-arm64\.AppImage/g,
                replacement: `GuruShotsAutoVote-v${version}-arm64.AppImage`,
            },
        ];

        // Apply all replacements
        filePatterns.forEach(({pattern, replacement}) => {
            if (pattern.test(content)) {
                content = content.replace(pattern, replacement);
                changesMade++;
            }
        });

        // Update download URLs to use the current version
        const urlPatterns = [
            {
                pattern: /https:\/\/github\.com\/isthisgitlab\/gurushots-auto-vote\/releases\/latest\/download\/GuruShotsAutoVote-v[\d.]+-x64\.exe/g,
                replacement: `https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/GuruShotsAutoVote-v${version}-x64.exe`,
            },
            {
                pattern: /https:\/\/github\.com\/isthisgitlab\/gurushots-auto-vote\/releases\/latest\/download\/GuruShotsAutoVote-v[\d.]+-arm64\.dmg/g,
                replacement: `https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/GuruShotsAutoVote-v${version}-arm64.dmg`,
            },
            {
                pattern: /https:\/\/github\.com\/isthisgitlab\/gurushots-auto-vote\/releases\/latest\/download\/GuruShotsAutoVote-v[\d.]+-x86_64\.AppImage/g,
                replacement: `https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/GuruShotsAutoVote-v${version}-x86_64.AppImage`,
            },
            {
                pattern: /https:\/\/github\.com\/isthisgitlab\/gurushots-auto-vote\/releases\/latest\/download\/GuruShotsAutoVote-v[\d.]+-arm64\.AppImage/g,
                replacement: `https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/GuruShotsAutoVote-v${version}-arm64.AppImage`,
            },
        ];

        // Apply all URL replacements
        urlPatterns.forEach(({pattern, replacement}) => {
            if (pattern.test(content)) {
                content = content.replace(pattern, replacement);
                changesMade++;
            }
        });

        // Update the Linux chmod command example
        const chmodPattern = /chmod \+x GuruShotsAutoVote-v[\d.]+-\*\.AppImage/g;
        if (chmodPattern.test(content)) {
            content = content.replace(chmodPattern, `chmod +x GuruShotsAutoVote-v${version}-*.AppImage`);
            changesMade++;
        }

        const runPattern = /\.\/GuruShotsAutoVote-v[\d.]+-\*\.AppImage/g;
        if (runPattern.test(content)) {
            content = content.replace(runPattern, `./GuruShotsAutoVote-v${version}-*.AppImage`);
            changesMade++;
        }

        // Write the updated content back to file
        fs.writeFileSync(fileInfo.path, content, 'utf8');

        if (changesMade > 0) {
            console.log(`✅ ${fileInfo.name} updated successfully with version ${version} (${changesMade} changes)`);
            totalChanges += changesMade;
        } else {
            console.log(`ℹ️  ${fileInfo.name} is already up to date with version ${version}`);
        }
    });

    if (totalChanges > 0) {
        console.log(`\n📝 Total changes made: ${totalChanges}`);
        console.log(`   - Updated version numbers to v${version}`);
        console.log(`   - Updated all download file names to v${version}`);
        console.log(`   - Updated all download URLs to v${version}`);
        console.log(`   - Updated command examples to v${version}`);
    } else {
        console.log(`\nℹ️  All documentation is already up to date with version ${version}`);
    }

} catch (error) {
    console.error(`❌ Error updating documentation: ${error.message}`);
    process.exit(1);
} 