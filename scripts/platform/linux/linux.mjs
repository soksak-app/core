// The Linux implementation of the platform operations of scripts/platform/platform.js. The selector loads this module only when an
// operation runs for the platform `linux`; an operation that this module does not export throws PlatformOperationNotImplemented.
export { processExecutable } from './process-executable.mjs';
