#!/usr/bin/env node

/**
 * Update README.md with current version information
 * This script updates the download links and version numbers in README.md
 * to match the current package.json version.
 */

const fs = require('fs');
const path = require('path');
const logger = require('../src/js/logger');

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

    logger.cliInfo(`Updating documentation with version ${version}...`);

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
            logger.cliWarning(`⚠️  ${fileInfo.name} not found, skipping...`);
            return;
        }

        let content = fs.readFileSync(fileInfo.path, 'utf8');
        let changesMade = 0;

        // Update the version number in the download section
        const versionPattern = /\*\*Latest Version: v[\d.]+(?:-[a-zA-Z0-9.]+)?/g;
        if (versionPattern.test(content)) {
            content = content.replace(versionPattern, `**Latest Version: v${version}`);
            changesMade++;
        }

        // Update all download links with the current version
        const filePatterns = [
            {
                pattern: /GuruShotsAutoVote-v[\d.]+(?:-[a-zA-Z0-9.]+)?-x64\.exe/g,
                replacement: `GuruShotsAutoVote-v${version}-x64.exe`,
            },
            {
                pattern: /GuruShotsAutoVote-v[\d.]+(?:-[a-zA-Z0-9.]+)?-arm64\.dmg/g,
                replacement: `GuruShotsAutoVote-v${version}-arm64.dmg`,
            },
            {
                pattern: /GuruShotsAutoVote-v[\d.]+(?:-[a-zA-Z0-9.]+)?-arm64\.app/g,
                replacement: `GuruShotsAutoVote-v${version}-arm64.app`,
            },
            {
                pattern: /GuruShotsAutoVote-v[\d.]+(?:-[a-zA-Z0-9.]+)?-x86_64\.AppImage/g,
                replacement: `GuruShotsAutoVote-v${version}-x86_64.AppImage`,
            },
            {
                pattern: /GuruShotsAutoVote-v[\d.]+(?:-[a-zA-Z0-9.]+)?-arm64\.AppImage/g,
                replacement: `GuruShotsAutoVote-v${version}-arm64.AppImage`,
            },
            // CLI files with version
            {
                pattern: /gurucli-v[\d.]+(?:-[a-zA-Z0-9.]+)?-mac/g,
                replacement: `gurucli-v${version}-mac`,
            },
            {
                pattern: /gurucli-v[\d.]+(?:-[a-zA-Z0-9.]+)?-linux/g,
                replacement: `gurucli-v${version}-linux`,
            },
            {
                pattern: /gurucli-v[\d.]+(?:-[a-zA-Z0-9.]+)?-linux-arm/g,
                replacement: `gurucli-v${version}-linux-arm`,
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
                pattern: /https:\/\/github\.com\/isthisgitlab\/gurushots-auto-vote\/releases\/latest\/download\/GuruShotsAutoVote-v[\d.]+(?:-[a-zA-Z0-9.]+)?-x64\.exe/g,
                replacement: `https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/GuruShotsAutoVote-v${version}-x64.exe`,
            },
            {
                pattern: /https:\/\/github\.com\/isthisgitlab\/gurushots-auto-vote\/releases\/latest\/download\/GuruShotsAutoVote-v[\d.]+(?:-[a-zA-Z0-9.]+)?-arm64\.dmg/g,
                replacement: `https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/GuruShotsAutoVote-v${version}-arm64.dmg`,
            },
            {
                pattern: /https:\/\/github\.com\/isthisgitlab\/gurushots-auto-vote\/releases\/latest\/download\/GuruShotsAutoVote-v[\d.]+(?:-[a-zA-Z0-9.]+)?-arm64\.app/g,
                replacement: `https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/GuruShotsAutoVote-v${version}-arm64.app`,
            },
            {
                pattern: /https:\/\/github\.com\/isthisgitlab\/gurushots-auto-vote\/releases\/latest\/download\/GuruShotsAutoVote-v[\d.]+(?:-[a-zA-Z0-9.]+)?-x86_64\.AppImage/g,
                replacement: `https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/GuruShotsAutoVote-v${version}-x86_64.AppImage`,
            },
            {
                pattern: /https:\/\/github\.com\/isthisgitlab\/gurushots-auto-vote\/releases\/latest\/download\/GuruShotsAutoVote-v[\d.]+(?:-[a-zA-Z0-9.]+)?-arm64\.AppImage/g,
                replacement: `https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/GuruShotsAutoVote-v${version}-arm64.AppImage`,
            },
            // CLI file URLs
            {
                pattern: /https:\/\/github\.com\/isthisgitlab\/gurushots-auto-vote\/releases\/latest\/download\/gurucli-v[\d.]+(?:-[a-zA-Z0-9.]+)?-mac/g,
                replacement: `https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/gurucli-v${version}-mac`,
            },
            {
                pattern: /https:\/\/github\.com\/isthisgitlab\/gurushots-auto-vote\/releases\/latest\/download\/gurucli-v[\d.]+(?:-[a-zA-Z0-9.]+)?-linux/g,
                replacement: `https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/gurucli-v${version}-linux`,
            },
            {
                pattern: /https:\/\/github\.com\/isthisgitlab\/gurushots-auto-vote\/releases\/latest\/download\/gurucli-v[\d.]+(?:-[a-zA-Z0-9.]+)?-linux-arm/g,
                replacement: `https://github.com/isthisgitlab/gurushots-auto-vote/releases/latest/download/gurucli-v${version}-linux-arm`,
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
        const chmodPattern = /chmod \+x GuruShotsAutoVote-v[\d.]+(?:-[a-zA-Z0-9.]+)?-\*\.AppImage/g;
        if (chmodPattern.test(content)) {
            content = content.replace(chmodPattern, `chmod +x GuruShotsAutoVote-v${version}-*.AppImage`);
            changesMade++;
        }

        const runPattern = /\.\/GuruShotsAutoVote-v[\d.]+(?:-[a-zA-Z0-9.]+)?-\*\.AppImage/g;
        if (runPattern.test(content)) {
            content = content.replace(runPattern, `./GuruShotsAutoVote-v${version}-*.AppImage`);
            changesMade++;
        }
        
        // Update CLI command examples
        const cliCommandPatterns = [
            {
                pattern: /gurucli-v[\d.]+(?:-[a-zA-Z0-9.]+)?-mac/g,
                replacement: `gurucli-v${version}-mac`,
            },
            {
                pattern: /gurucli-v[\d.]+(?:-[a-zA-Z0-9.]+)?-linux/g,
                replacement: `gurucli-v${version}-linux`,
            },
            {
                pattern: /gurucli-v[\d.]+(?:-[a-zA-Z0-9.]+)?-linux-arm/g,
                replacement: `gurucli-v${version}-linux-arm`,
            },
            // Handle CLI command examples with [platform] placeholder
            {
                pattern: /\.\/gurucli-v[\d.]+(?:-[a-zA-Z0-9.]+)?-\[platform\]/g,
                replacement: `./gurucli-v${version}-[platform]`,
            },
        ];
        
        // Apply CLI command replacements
        cliCommandPatterns.forEach(({pattern, replacement}) => {
            if (pattern.test(content)) {
                content = content.replace(pattern, replacement);
                changesMade++;
            }
        });

        // Write the updated content back to file
        fs.writeFileSync(fileInfo.path, content, 'utf8');

        if (changesMade > 0) {
            logger.cliSuccess(`✅ ${fileInfo.name} updated successfully with version ${version} (${changesMade} changes)`);
            totalChanges += changesMade;
        } else {
            logger.cliInfo(`ℹ️  ${fileInfo.name} is already up to date with version ${version}`);
        }
    });

    if (totalChanges > 0) {
        logger.cliInfo(`\n📝 Total changes made: ${totalChanges}`);
        logger.cliInfo(`   - Updated version numbers to v${version}`);
        logger.cliInfo(`   - Updated all download file names to v${version}`);
        logger.cliInfo(`   - Updated all download URLs to v${version}`);
        logger.cliInfo(`   - Updated command examples to v${version}`);
    } else {
        logger.cliInfo(`\nℹ️  All documentation is already up to date with version ${version}`);
    }

} catch (error) {
    logger.cliError(`❌ Error updating documentation: ${error.message}`);
    process.exit(1);
} 