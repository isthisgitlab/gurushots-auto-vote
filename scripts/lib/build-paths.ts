import path from 'node:path';

const ROOT = path.join(__dirname, '..', '..');
const DIST_DIR = path.join(ROOT, 'dist');
const OUT_DIR = path.join(ROOT, 'out');
const RENDERER_DIR = path.join(OUT_DIR, 'renderer');
const ASSEMBLY_DIR = path.join(OUT_DIR, 'assembly');
const CLI_DIR = path.join(OUT_DIR, 'cli');

const rendererOutputDir = (lite: boolean): string => path.join(RENDERER_DIR, lite ? 'lite' : 'full');
const rendererBundleDir = (lite: boolean): string => path.join(rendererOutputDir(lite), 'bundles');
const rendererStylesheetPath = path.join(RENDERER_DIR, 'styles.css');
const assemblyOutputDir = (lite: boolean): string => path.join(ASSEMBLY_DIR, lite ? 'lite' : 'full');

export {
    ROOT,
    DIST_DIR,
    OUT_DIR,
    RENDERER_DIR,
    ASSEMBLY_DIR,
    CLI_DIR,
    rendererOutputDir,
    rendererBundleDir,
    rendererStylesheetPath,
    assemblyOutputDir,
};
