// Select the operating-system implementation used by E2E setup.
const modules = {
  darwin: "./darwin/darwin.js",
};

const selected = modules[process.platform];
if (!selected) throw new Error(`E2E setup is not implemented on ${process.platform}`);

export const { captureTextCommand, debugBinaries } = await import(selected);
