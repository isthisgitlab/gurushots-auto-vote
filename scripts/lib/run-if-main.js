// Runs a script's entry point only when the file is executed directly
// (`node scripts/x.js`), so requiring it — from another script or a test — has
// no side effects. A plain function rather than an inline
// `if (require.main === module)` so the wiring is unit-testable: under Jest,
// require.main is always the test file, never the script.
const runIfMain = (mainModule, mod, run) => mainModule === mod && run();

module.exports = { runIfMain };
