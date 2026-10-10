// The runtime for workbench tests. It has no native host.
export const host = null;
export const page = null;

export const openStore = () => {
  throw new Error("workbench tests do not open a store");
};

export const windows = null;
