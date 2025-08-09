#!/usr/bin/env node

const { build } = require('esbuild');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const packageJson = require('../package.json');
const version = packageJson.version;

const platforms = [
    { target: 'node22-macos-arm64', input: 'gurucli-mac', output: `gurucli-v${version}-mac` },
    { target: 'node22-linux-x64', input: 'gurucli-linux', output: `gurucli-v${version}-linux` },
    { target: 'node22-linux-arm64', input: 'gurucli-linux-arm', output: `gurucli-v${version}-linux-arm` },
];

async function buildCliForPlatform(target, outputName) {
    console.log(`🔨 Building CLI for ${target}...`);
  
    try {
        const pkgCommand = `npx --yes @yao-pkg/pkg ${path.join(__dirname, '..', 'dist', 'cli-bundled.js')} --targets ${target} --output ${path.join(__dirname, '..', 'build', 'cli', outputName)}`;
        execSync(pkgCommand, { stdio: 'inherit' });
        console.log(`✅ Built ${outputName} successfully`);
    } catch (error) {
        console.error(`❌ Failed to build ${outputName}:`, error.message);
        throw error;
    }
}

async function buildCli(platform = null) {
    console.log('🔨 Building CLI with esbuild...');
  
    // Create dist directory if it doesn't exist
    const distDir = path.join(__dirname, '..', 'dist');
    if (!fs.existsSync(distDir)) {
        fs.mkdirSync(distDir, { recursive: true });
    }

    // Create build/cli directory if it doesn't exist
    const buildCliDir = path.join(__dirname, '..', 'build', 'cli');
    if (!fs.existsSync(buildCliDir)) {
        fs.mkdirSync(buildCliDir, { recursive: true });
    }

    try {
    // Bundle the CLI with esbuild (only once)
        await build({
            entryPoints: [path.join(__dirname, '..', 'src', 'js', 'cli', 'cli.js')],
            bundle: true,
            platform: 'node',
            target: 'node22',
            format: 'cjs',
            outfile: path.join(distDir, 'cli-bundled.js'),
            external: ['electron'], // Don't bundle electron
            minify: false,
            sourcemap: false,
            define: {
                'process.env.NODE_ENV': '"production"',
            },
        });

        console.log('✅ CLI bundled successfully');
    
        // Build for specific platform or all platforms
        if (platform) {
            const targetPlatform = platforms.find(p => p.input === platform);
            if (targetPlatform) {
                await buildCliForPlatform(targetPlatform.target, targetPlatform.output);
            } else {
                throw new Error(`Unknown platform: ${platform}`);
            }
        } else {
            // Build for all platforms
            console.log('📦 Packaging for all platforms...');
            for (const p of platforms) {
                await buildCliForPlatform(p.target, p.output);
            }
        }
    
        console.log('🎉 CLI build completed successfully!');
    
    } catch (error) {
        console.error('❌ Build failed:', error);
        process.exit(1);
    }
}

// Get platform from command line argument
const platform = process.argv[2];
buildCli(platform); 