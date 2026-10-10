// Selects the operating system transport of the local endpoint.
//
// Each operating system module exports values of the same names.
//   name                   operating system name
//   transport              transport name ("unix" or "pipe")
//   createAddress(label)   creates an owner-only address and returns { address, remove }
const modules = {
  darwin: "./darwin/darwin.js",
  linux: "./linux/linux.js",
  win32: "./windows/windows.js",
};

const selected = modules[process.platform];
if (!selected) throw new Error(`no endpoint transport for ${process.platform}`);

export const { name, transport, createAddress } = await import(selected);
