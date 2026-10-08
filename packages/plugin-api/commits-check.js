#!/usr/bin/env node
// 커밋 메시지가 `type(scope): Subject (#ID)`, 빈 줄, 비지 않은 본문, 꼬리말 없음의 형식인지 검사한다. 인자가 파일이면 그
// 메시지를(commit-msg hook), 아니면 git 범위의 각 커밋을 검사한다.
//
//   soksak-commits <message file | revision range>
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { commitMessageErrors } from "./records-check.js";

/** target 의 메시지마다 [이름, 메시지]. 파일은 그 메시지 하나, 범위는 merge 가 아닌 각 커밋이다. */
export function commitMessages(target) {
  if (existsSync(target)) return [["message", readFileSync(target, "utf8").replace(/^#.*\n?/gm, "")]];
  return execFileSync("git", ["rev-list", "--no-merges", target], { encoding: "utf8" }).split("\n").filter(Boolean)
    .map((commit) => [commit.slice(0, 12), execFileSync("git", ["log", "-1", "--format=%B", commit], { encoding: "utf8" })]);
}

// package manager 는 package 를 link 로 두므로 시작한 경로를 풀어서 이 module 과 비교한다.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const [target] = process.argv.slice(2);
  if (!target) {
    process.stderr.write("usage: soksak-commits <message file | revision range>\n");
    process.exit(2);
  }
  const messages = commitMessages(target);
  const errors = messages.flatMap(([name, message]) => commitMessageErrors(message).map((error) => `${name}: ${error}`));
  if (errors.length) {
    process.stderr.write(errors.map((error) => `${error}\n`).join(""));
    process.exit(1);
  }
  process.stdout.write(`Commit message checks passed: ${messages.length} messages\n`);
}
