// Resolves the native library input of one run of `make go-repeat` for a Go package. A package needs the library when a package
// in its build graph, test packages included, names the pkg-config package soksak-darwin in a cgo directive; native/darwin
// installs that pkg-config package with the library. The output is the CGO_CFLAGS define that keys the build to the content
// of the library. A package that needs no library prints nothing and does not read the library.
// Usage: node scripts/go-repeat-inputs.mjs <package> [<tags>]
import {createHash} from "node:crypto";
import {execFileSync} from "node:child_process";
import {existsSync, readFileSync} from "node:fs";

const LIBRARY = "native/darwin/build/libsoksak-darwin.a";
const [pkg, tags = ""] = process.argv.slice(2);

let listed;
try {
  // go list prints one line per package of the build graph, each line holding the pkg-config packages of that package.
  listed = execFileSync(
    "go",
    ["list", "-deps", "-test", "-f", '{{join .CgoPkgConfig " "}}', ...(tags ? ["-tags", tags] : []), pkg],
    { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  );
} catch (error) {
  console.error(`go-repeat: go list failed for ${pkg} (exit ${error.status})`);
  process.exit(1);
}

const linksLibrary = listed.split("\n").some((line) => line.split(" ").includes("soksak-darwin"));
if (!linksLibrary) process.exit(0);

if (!existsSync(LIBRARY)) {
  console.error(`go-repeat: ${pkg} links ${LIBRARY}, which is not built; run make -C native/darwin first`);
  process.exit(1);
}
const digest = createHash("sha256").update(readFileSync(LIBRARY)).digest("hex").slice(0, 16);
process.stdout.write(`-DSOKSAK_DARWIN_LIBRARY=${digest}\n`);
