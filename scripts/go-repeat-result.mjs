// Judges one run of `make go-repeat` from the events of `go test -json` (cmd/test2json). A run passes when go test
// succeeded and at least one test passed in the packages of PACKAGE. A package of the pattern without test files, such as
// a support package of tests, ends with the package event `skip` and does not decide the run; the run fails as having no
// test files when no package has test files, and otherwise as having no matching test.
// Usage: node scripts/go-repeat-result.mjs <output file> <go test exit status> <package> <test> <tags>
import { readFileSync } from "node:fs";

const [file, status, pkg, name, tags] = process.argv.slice(2);
const text = readFileSync(file, "utf8");
const events = [];
let printed = "";
for (const line of text.split("\n")) {
  if (line === "") continue;
  // A build error of go test is printed as text, not as an event.
  if (!line.startsWith("{")) {
    printed += `${line}\n`;
    continue;
  }
  const event = JSON.parse(line);
  events.push(event);
  if (event.Action === "output") printed += event.Output;
}

const fail = (message) => {
  process.stdout.write(printed);
  if (message) console.error(`FAIL: ${message}`);
  process.exit(1);
};
if (status !== "0") fail();
if (!events.some((event) => event.Action === "pass" && event.Test !== undefined)) {
  // A package with test files ends with the package event `pass`; a package without them ends with `skip`.
  const testedPackage = events.some((event) => event.Action === "pass" && event.Test === undefined);
  if (!testedPackage) fail(`${pkg} has no test files built with tags '${tags}'`);
  fail(`${pkg} has no test matching ${name}`);
}
