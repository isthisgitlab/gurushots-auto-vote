#!/usr/bin/env node

const { build, context } = require('esbuild');
const path = require('path');
const fs = require('fs');

const reactDir = path.join(__dirname, '..', 'src', 'js', 'react');
const distDir = path.join(__dirname, '..', 'dist');

// Entry points for each page
const entryPoints = {
    login: path.join(reactDir, 'pages', 'Login.jsx'),
    app: path.join(reactDir, 'pages', 'App.jsx'),
    logs: path.join(reactDir, 'pages', 'Logs.jsx'),
};

// Check if watch mode is enabled
const isWatch = process.argv.includes('--watch');

async function buildReact() {
    console.log(`🔨 Building React bundles${isWatch ? ' (watch mode)' : ''}...`);

    // Create dist directory if it doesn't exist
    if (!fs.existsSync(distDir)) {
        fs.mkdirSync(distDir, { recursive: true });
    }

    const commonOptions = {
        bundle: true,
        platform: 'browser',
        format: 'iife',
        target: 'es2020',
        jsx: 'automatic',
        minify: process.env.NODE_ENV === 'production',
        sourcemap: process.env.NODE_ENV !== 'production',
        loader: {
            '.jsx': 'jsx',
            '.js': 'js',
        },
        alias: {
            '@': reactDir,
        },
        define: {
            'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV || 'development'),
        },
    };

    try {
        if (isWatch) {
            // Watch mode - create contexts for each entry point
            const contexts = [];

            for (const [name, entry] of Object.entries(entryPoints)) {
                // Only build if entry file exists
                if (!fs.existsSync(entry)) {
                    console.log(`⏭️  Skipping ${name} (file not found: ${entry})`);
                    continue;
                }

                const ctx = await context({
                    ...commonOptions,
                    entryPoints: [entry],
                    outfile: path.join(distDir, `${name}-bundle.js`),
                });

                contexts.push({ name, ctx });
            }

            if (contexts.length === 0) {
                console.log('⚠️  No React entry points found. Create pages in src/js/react/pages/');
                return;
            }

            // Start watching all contexts
            for (const { name, ctx } of contexts) {
                await ctx.watch();
                console.log(`👀 Watching ${name}...`);
            }

            console.log('\n✅ Watch mode active. Press Ctrl+C to stop.\n');

            // Keep process alive
            process.on('SIGINT', async () => {
                console.log('\n🛑 Stopping watch mode...');
                for (const { ctx } of contexts) {
                    await ctx.dispose();
                }
                process.exit(0);
            });
        } else {
            // Build mode - build each entry point
            let builtCount = 0;

            for (const [name, entry] of Object.entries(entryPoints)) {
                // Only build if entry file exists
                if (!fs.existsSync(entry)) {
                    console.log(`⏭️  Skipping ${name} (file not found: ${entry})`);
                    continue;
                }

                await build({
                    ...commonOptions,
                    entryPoints: [entry],
                    outfile: path.join(distDir, `${name}-bundle.js`),
                });

                console.log(`✅ Built ${name}-bundle.js`);
                builtCount++;
            }

            if (builtCount === 0) {
                console.log('⚠️  No React entry points found. Create pages in src/js/react/pages/');
            } else {
                console.log(`\n🎉 React build completed! (${builtCount} bundles)`);
            }
        }
    } catch (error) {
        console.error('❌ Build failed:', error);
        process.exit(1);
    }
}

buildReact();
