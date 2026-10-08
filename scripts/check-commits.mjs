// 커밋 메시지 형식을 검사한다. 인자가 파일이면 그 메시지를(commit-msg hook), 아니면 git 범위의 각 커밋을 검사한다.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { commitMessageErrors } from "./records.mjs";

const [target] = process.argv.slice(2);
if (!target) {
  console.error("usage: node scripts/check-commits.mjs <message file | revision range>");
  process.exit(2);
}
const messages = existsSync(target)
  ? [["message", readFileSync(target, "utf8").replace(/^#.*\n?/gm, "")]]
  : execFileSync("git", ["rev-list", "--no-merges", target], { encoding: "utf8" }).split("\n").filter(Boolean)
    .map((commit) => [commit.slice(0, 12), execFileSync("git", ["log", "-1", "--format=%B", commit], { encoding: "utf8" })]);
const errors = messages.flatMap(([name, message]) => commitMessageErrors(message).map((error) => `${name}: ${error}`));
if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else console.log(`Commit message checks passed: ${messages.length} messages`);
