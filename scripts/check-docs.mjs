import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";

const files = [...new Set(execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { encoding: "utf8" }).split("\0"))].filter((file) => file.endsWith(".md") && existsSync(file));
const errors = [];
const withoutCode = (text) => text.replace(/^(`{3,}|~{3,}).*\n[\s\S]*?^\1\s*$/gm, "");
const anchors = (text) => {
  const found = new Set();
  for (const match of withoutCode(text).matchAll(/^#{1,6}\s+(.+)$/gm)) {
    const base = match[1].toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").trim().replace(/\s/g, "-");
    let id = base, count = 0;
    while (found.has(id)) id = `${base}-${++count}`;
    found.add(id);
  }
  return found;
};

for (const file of files) {
  const partner = file.endsWith(".ko.md") ? file.replace(/\.ko\.md$/, ".md") : file.replace(/\.md$/, ".ko.md");
  if (!existsSync(partner)) errors.push(`${file}: missing translation pair ${partner}`);
  const text = withoutCode(readFileSync(file, "utf8"));
  for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = match[1].replace(/^<|>$/g, "");
    if (/^[a-z][a-z\d+.-]*:/i.test(target)) continue;
    const [path, fragment] = target.split("#");
    const full = path ? resolve(dirname(file), decodeURIComponent(path)) : resolve(file);
    if (!existsSync(full)) errors.push(`${file}: missing link target ${target}`);
    else if (fragment && extname(full) === ".md" && !anchors(readFileSync(full, "utf8")).has(decodeURIComponent(fragment))) {
      errors.push(`${file}: missing heading ${target}`);
    }
  }
}

const statusFiles = ["docs/features.md", "docs/features.ko.md"];
const counts = statusFiles.map((file, language) => {
  const rows = readFileSync(file, "utf8").split("\n").filter((line) => line.startsWith("|"));
  const expected = language === 0 ? ["Feature", "Implementation", "Validation", "Release"] : ["기능", "구현", "검증", "배포"];
  const cells = (line) => line.split("|").slice(1, -1).map((cell) => cell.trim());
  if (JSON.stringify(cells(rows[0] ?? "")) !== JSON.stringify(expected)) errors.push(`${file}: status columns must be ${expected.join(", ")}`);
  for (const row of rows.slice(2)) {
    const values = cells(row);
    if (values.length !== 4 || values.some((value) => !value)) errors.push(`${file}: incomplete status row ${row}`);
    if (!(language === 0 ? ["Unreleased", "Released"] : ["미배포", "배포됨"]).includes(values[3])) errors.push(`${file}: invalid release status ${values[3]}`);
  }
  if (rows.length < 3) errors.push(`${file}: no feature status entries`);
  return rows.length;
});
if (counts[0] !== counts[1]) errors.push("feature translations have different row counts");
if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else console.log(`Documentation checks passed: ${files.length} files; links, translations, and status fields`);
