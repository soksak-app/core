// 추적하는 문서와 설정 주석이 기록 규칙을 지키는지 검사한다(AGENTS.md Documentation). 위반은 `path:line` 으로 보고한다.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { recordKind, recordViolations } from "./records.mjs";

const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { encoding: "utf8" })
  .split("\0").filter((file) => file && recordKind(file) && existsSync(file));
const errors = files.flatMap((file) => recordViolations(readFileSync(file, "utf8"), file, recordKind(file)));
if (errors.length) {
  console.error(errors.join("\n"));
  console.error(`${errors.length} record lines state something other than facts about this repository`);
  process.exitCode = 1;
} else console.log(`Record checks passed: ${files.length} files`);
