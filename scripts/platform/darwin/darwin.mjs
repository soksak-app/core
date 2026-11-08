// The macOS implementation of the platform operations of scripts/platform/platform.js. The selector loads this module only when an
// operation runs for the platform `darwin`.
export { applicationArtifact, applicationExecutables } from './artifacts.mjs';
export { crashReports, listProcesses, openApplication, quitApplication, runNativeTests, waitForLockRelease } from './end-to-end.mjs';
export { processExecutable } from './process-executable.mjs';
