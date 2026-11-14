// A process that stays alive until a signal ends it: the host process that a window-check test names in an endpoint and samples
// or lets exit. It prints `ready` when it runs.
process.stdout.write("ready\n");
setInterval(() => {}, 2 ** 30);
