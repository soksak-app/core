#!/usr/bin/env node
// The pack command and `pnpm` of the registry tests: writes the release file that `pnpm pack` names, from the package.json of the
// current folder, into the destination that is its last argument.
import { readFileSync, writeFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const out = process.argv.at(-1);
writeFileSync(`${out}/${pkg.name.replace(/^@/, "").replace("/", "-")}-${pkg.version}.tgz`, pkg.name);
