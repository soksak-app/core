// The command of the run tests of test-app.mjs. The mode, its first argument, selects what it does:
//   out    writes "out" to standard output and ends with status 0
//   fail3  writes "bad" to standard error and ends with status 3
//   fail4  ends with status 4
//   wait   runs until a signal ends it
const mode = process.argv[2];
if (mode === "out") process.stdout.write("out");
else if (mode === "fail3") { process.stderr.write("bad"); process.exit(3); }
else if (mode === "fail4") process.exit(4);
else if (mode === "wait") setTimeout(() => {}, 60000);
else throw new Error(`command-probe: unknown mode ${mode}`);
