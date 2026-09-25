// @pierre/trees 를 ui/vendor/trees.js 한 파일로 번들한다(docs/spec/plugins.md#third-party-libraries).
// --check 는 새로 만든 번들이 커밋된 파일과 같은지 검사하고 다르면 실패한다.
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { build } from "esbuild";

const OUTPUT = new URL("../ui/vendor/trees.js", import.meta.url);
const NOTICES = new URL("../ui/vendor/trees.LICENSE.txt", import.meta.url);
/* 번들에 들어간 패키지의 라이선스와 고지. 배포물에 함께 둔다. */
const trees = dirname(realpathSync(new URL("../node_modules/@pierre/trees/package.json", import.meta.url)));
const preact = dirname(createRequire(join(trees, "package.json")).resolve("preact/package.json"));
const notices = [
  ["@pierre/trees 1.0.0-beta.4 (Apache-2.0)", join(trees, "LICENSE.md")],
  ["@pierre/trees NOTICE", join(trees, "NOTICE.md")],
  ["preact (MIT)", join(preact, "LICENSE")],
].map(([title, path]) => `# ${title}\n\n${readFileSync(path, "utf8").trim()}\n`).join("\n");
const result = await build({
  entryPoints: [new URL("../vendor/trees.js", import.meta.url).pathname],
  bundle: true,
  format: "esm",
  target: "safari17",
  legalComments: "eof",
  write: false,
  logLevel: "silent",
});
const bundled = result.outputFiles[0].text;
if (process.argv.includes("--check")) {
  for (const [file, text] of [[OUTPUT, bundled], [NOTICES, notices]]) {
    if (readFileSync(file, "utf8") !== text) {
      console.error(`${file.pathname} differs from a new build; run pnpm -F @soksak/plugin-files build`);
      process.exit(1);
    }
  }
} else {
  writeFileSync(OUTPUT, bundled);
  writeFileSync(NOTICES, notices);
}
