import assert from "node:assert/strict";
import { chmodSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import test from "node:test";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { STAGED } from "../staged.js";

const testFile = fileURLToPath(import.meta.url);
const testDir = dirname(testFile);
const workbenchDir = dirname(testDir);
const packagesDir = dirname(workbenchDir);
const root = dirname(packagesDir);

/** 파일이 없을 때만 null 을 돌려준다. 다른 오류는 경로를 붙여 던진다. */
function statOrNull(path) {
  try {
    return statSync(path);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error(`${path}: ${error.message}`, { cause: error });
  }
}

/** 파일을 읽는다. 실패하면 경로를 붙여 던진다. */
function readText(path) {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`${path}: ${error.message}`, { cause: error });
  }
}

/** JSON 파일을 읽는다. 읽거나 해석하지 못하면 경로를 붙여 던진다. */
function readJson(path) {
  const text = readText(path);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${path}: ${error.message}`, { cause: error });
  }
}

/** The source folders by the name of their package.json. */
function getSourceFolders(base = root) {
  const packages = new Map();
  // plugin 은 자기 repository 에 있다(docs/spec/plugins.md#repositories).
  const places = ["packages"];

  for (const place of places) {
    const placeDir = join(base, place);
    const dirs = readdirSync(placeDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);

    for (const dir of dirs) {
      const packageJsonPath = join(placeDir, dir, "package.json");
      // package.json 이 없는 폴더는 패키지가 아니다. 있는데 읽지 못하면 실패한다.
      if (!statOrNull(packageJsonPath)) continue;
      packages.set(readJson(packageJsonPath).name, join(placeDir, dir));
    }
  }

  return packages;
}

/** 파일이 배포 목록에 포함되는지 확인한다. */
function isInPublishedFiles(publishedPath, filesArray, packageDir) {
  for (const fileEntry of filesArray) {
    const fullPath = join(packageDir, fileEntry);

    // 디렉터리면 그 아래의 모든 파일이 포함된다. 없는 항목은 디렉터리가 아니다.
    if (statOrNull(fullPath)?.isDirectory() && publishedPath.startsWith(fileEntry + "/")) {
      return true;
    }

    // 정확히 일치하는 파일
    if (fileEntry === publishedPath) {
      return true;
    }
  }

  return false;
}

/** JavaScript 파일에서 상대 경로 import 추출 */
function extractJsImports(content) {
  const imports = [];

  // from "..." 또는 from '...' 형태를 모두 찾기
  const fromRegex = /from\s+["'](\.[^"']*?)["']/g;
  let match;
  while ((match = fromRegex.exec(content)) !== null) {
    const importPath = match[1];
    imports.push(importPath);
  }

  // import "./x" 형식의 부수 효과 import
  const importSideEffectRegex = /import\s+["'](\.[^"']*?)["']/g;
  while ((match = importSideEffectRegex.exec(content)) !== null) {
    const importPath = match[1];
    imports.push(importPath);
  }

  return [...new Set(imports)]; // 중복 제거
}

/** HTML 파일에서 상대 경로 import 추출 */
function extractHtmlImports(content) {
  const imports = [];

  // <script type="module"> 안의 import
  const scriptRegex = /<script\s+type\s*=\s*["']module["']\s*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = scriptRegex.exec(content)) !== null) {
    const scriptContent = match[1];
    const jsImports = extractJsImports(scriptContent);
    imports.push(...jsImports);
  }

  // <script src="./x">
  const scriptSrcRegex = /<script\s+[^>]*src\s*=\s*["'](\.[^"']*?)["']/gi;
  while ((match = scriptSrcRegex.exec(content)) !== null) {
    const importPath = match[1];
    imports.push(importPath);
  }

  return imports;
}

/** 상대 import를 절대 경로로 해석 */
function resolveImportPath(importPath, fromDir) {
  let resolvedPath = resolve(fromDir, importPath);

  // 확장자가 없으면 .js 추가 시도
  if (!resolvedPath.endsWith(".js") && !resolvedPath.endsWith(".json")) {
    const stat = statOrNull(resolvedPath);
    // 없는 경로는 확장자를 뺀 import 이므로 .js 를 붙인다.
    if (!stat) resolvedPath = resolvedPath + ".js";
    else if (stat.isDirectory()) resolvedPath = join(resolvedPath, "index.js");
  }

  return resolvedPath;
}

/** 절대 경로를 패키지 기준 상대 경로로 변환 */
function makeRelativePath(absolutePath, packageDir) {
  let relPath = relative(packageDir, absolutePath);
  // 역슬래시를 전진슬래시로
  return relPath.split("\\").join("/");
}

/** 패키지의 build 스크립트가 있는지 확인 */
function hasBuildScript(packageDir) {
  return Boolean(readJson(join(packageDir, "package.json")).scripts?.build);
}

/** 빌드 산출 디렉터리 목록 구성. package.json의 files와 빌드 스크립트 기반. */
function getBuildOutputDirs(packageDir, filesArray) {
  const buildDirs = new Set();

  // 빌드 스크립트가 없으면 산출 디렉터리가 없다
  if (!hasBuildScript(packageDir)) {
    return buildDirs;
  }

  for (const fileEntry of filesArray) {
    const fullPath = join(packageDir, fileEntry);

    const stat = statOrNull(fullPath);
    if (stat?.isDirectory()) {
      buildDirs.add(fileEntry);
    } else if (!stat && (fileEntry.endsWith("/") || !fileEntry.includes("."))) {
      // 없는 디렉터리는 아직 빌드되지 않은 산출물이다. 경로가 /로 끝나거나 확장자가 없으면 산출 디렉터리다.
      buildDirs.add(fileEntry);
    }
  }

  return buildDirs;
}

/** 경로가 빌드 산출 디렉터리 아래인지 확인 */
function isInBuildOutputDir(resolvedPath, packageDir, buildOutputDirs) {
  for (const dir of buildOutputDirs) {
    const normDir = dir.replace(/\/$/, "");
    if (resolvedPath.startsWith(normDir + "/") || resolvedPath === normDir) {
      return true;
    }
  }
  return false;
}

/** 모든 배포 파일 스캔. 존재하지 않는 파일은 결과에 missing: true로 포함된다 */
function collectPublishedImports(name, packageDir, filesArray) {
  const results = [];
  const checkedFiles = new Set();
  const buildOutputDirs = getBuildOutputDirs(packageDir, filesArray);
  // 워크벤치는 스테이징이 만드는 파일들을 import할 수 있다
  const isWorkbench = name === "@soksak/workbench";

  function processFile(filePath) {
    if (checkedFiles.has(filePath)) return;
    checkedFiles.add(filePath);
    const isHtml = filePath.endsWith(".html");
    if (!isHtml && !filePath.endsWith(".js")) return;
    const content = readText(filePath);
    const imports = isHtml ? extractHtmlImports(content) : extractJsImports(content);
    const fromDir = dirname(filePath);
    const file = makeRelativePath(filePath, packageDir);

    for (const importPath of imports) {
      const relativePath = makeRelativePath(resolveImportPath(importPath, fromDir), packageDir);
      if (statOrNull(join(packageDir, relativePath))) {
        results.push({ file, importPath, resolvedPath: relativePath, inPublished: isInPublishedFiles(relativePath, filesArray, packageDir) });
        continue;
      }
      // 워크벤치는 스테이징이 모든 빌드에서 만드는 파일을 import 할 수 있다.
      if (isWorkbench && STAGED.always.includes(relativePath)) {
        results.push({ file, importPath, resolvedPath: relativePath, inPublished: true, isStaged: true, stagedType: "always" });
        continue;
      }
      // host 가 제공하는 문서는 스테이징된 파일이 아니라 host 의 응답이다.
      if (isWorkbench && STAGED.served.includes(relativePath)) {
        results.push({ file, importPath, resolvedPath: relativePath, inPublished: true, isStaged: true, stagedType: "served" });
        continue;
      }
      // 진단 빌드에서만 만드는 파일을 무조건 import 하면 릴리스에서 없다.
      if (isWorkbench && STAGED.diagnostics.includes(relativePath)) {
        results.push({ file, importPath, resolvedPath: relativePath, inPublished: false, missing: true, isDiagnosticsOnly: true });
        continue;
      }
      // 빌드 산출물은 검사 때 아직 없을 수 있다.
      if (isInBuildOutputDir(relativePath, packageDir, buildOutputDirs)) {
        results.push({ file, importPath, resolvedPath: relativePath, inPublished: true, isBuildOutput: true });
        continue;
      }
      results.push({ file, importPath, resolvedPath: relativePath, inPublished: false, missing: true });
    }
  }

  /** 디렉터리 안의 모든 JS/HTML 파일을 처리한다. */
  function walkDir(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullEntry = join(dir, entry.name);
      if (entry.isDirectory()) walkDir(fullEntry);
      else if (entry.name.endsWith(".js") || entry.name.endsWith(".html")) processFile(fullEntry);
    }
  }

  // 모든 published 파일 처리. 없는 항목은 빌드 산출물일 때만 허용하고, 아니면 누락으로 보고한다.
  for (const fileEntry of filesArray) {
    const fullPath = join(packageDir, fileEntry);
    const stat = statOrNull(fullPath);
    if (!stat) {
      if (!isInBuildOutputDir(fileEntry, packageDir, buildOutputDirs)) {
        results.push({ file: "package.json", importPath: fileEntry, resolvedPath: fileEntry, inPublished: false, missing: true });
      }
      continue;
    }
    if (stat.isDirectory()) walkDir(fullPath);
    else if (fileEntry.endsWith(".js") || fileEntry.endsWith(".html")) processFile(fullPath);
  }

  return results;
}

test("every import of a published file is listed in its package files", () => {
  const packages = getSourceFolders();
  const errors = [];
  const allowed = []; // 스테이징이나 빌드로 생성되는 파일들

  for (const [name, packageDir] of packages) {
    const packageJsonPath = join(packageDir, "package.json");

    {
      const pkg = readJson(packageJsonPath);

      if (!Array.isArray(pkg.files)) {
        // files가 없으면 이 패키지는 배포하지 않음
        continue;
      }

      const imports = collectPublishedImports(name, packageDir, pkg.files);

      for (const imp of imports) {
        // 스테이징이 만드는 파일은 허용 (배포 때 stage.mjs가 만듦)
        if (imp.isStaged) {
          allowed.push(`${name}: ${imp.file} → ${imp.resolvedPath} (${imp.stagedType === "served" ? "host 가 제공" : "스테이징이 생성"})`);
          continue;
        }

        // 빌드 산출물은 허용 (테스트 때 아직 생성되지 않지만 build 후 생김)
        if (imp.isBuildOutput) {
          allowed.push(`${name}: ${imp.file} → ${imp.resolvedPath} (빌드 산출물)`);
          continue;
        }

        // 존재하지 않는 파일은 실패
        if (imp.missing) {
          errors.push(`패키지 ${name}의 ${imp.file}이 import 하는 ${imp.resolvedPath}이 존재하지 않는다`);
          continue;
        }

        // 존재하지만 files에 없는 파일은 실패
        if (!imp.inPublished) {
          errors.push(`패키지 ${name}의 ${imp.file}이 import 하는 ${imp.resolvedPath}이 files에 없다`);
        }
      }
    }
  }

  // 테스트 출력에 허용된 항목들을 기록
  if (allowed.length > 0) {
    console.log(`ℹ 스테이징이나 빌드로 생성되는 import: ${allowed.length}개`);
    for (const item of allowed) {
      console.log(`  ${item}`);
    }
  }

  if (errors.length > 0) {
    assert.fail(errors.join("\n"));
  }
});

test("an import of a missing file is reported as missing", () => {
  // 임시 픽스처 패키지 생성
  const tmpDir = join(tmpdir(), `fixture-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpDir, { recursive: true });

  try {
    // package.json: app.js를 files에 포함시킴
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({
      name: "test-fixture-missing-import",
      files: ["app.js"]
    }, null, 2));

    // app.js: 존재하지 않는 파일 import
    writeFileSync(join(tmpDir, "app.js"), `import "./missing-dependency.js";\n`);

    // collectPublishedImports 호출하면 missing: true인 항목이 나와야 함
    const imports = collectPublishedImports("test-fixture", tmpDir, ["app.js"]);

    // missing 플래그가 있는 항목을 찾음
    const missingItems = imports.filter(imp => imp.missing);

    assert.ok(missingItems.length > 0, "누락된 import을 감지해야 함");
    assert.ok(missingItems[0].resolvedPath.includes("missing-dependency"),
      "missing-dependency.js가 누락된 것으로 보고되어야 함");

    // 이제 이 결과로 테스트 실패를 검증
    const errors = [];
    for (const imp of imports) {
      if (imp.missing) {
        errors.push(`패키지 test-fixture의 ${imp.file}이 import 하는 ${imp.resolvedPath}이 존재하지 않는다`);
      }
    }

    assert.ok(errors.length > 0, "누락된 파일은 오류를 생성해야 함");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("an unconditional import of a diagnostics-only file is reported", () => {
  // transcript.js는 진단 빌드에서만 생기므로, 이를 import하는 것을 검증
  // 임시 워크벤치 픽스처 생성
  const tmpDir = join(tmpdir(), `fixture-diag-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpDir, { recursive: true });

  try {
    // 워크벤치 스타일 package.json
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({
      name: "@soksak/workbench",
      files: ["app.js", "app.html"]
    }, null, 2));

    // 파일 1: JavaScript에서 진단 전용 파일 import
    writeFileSync(join(tmpDir, "app.js"), `import "./transcript.js";\n`);

    // 파일 2: HTML에서 진단 전용 파일 import (side-effect)
    writeFileSync(join(tmpDir, "app.html"), `<script type="module">
import "./transcript.js";
</script>\n`);

    // collectPublishedImports 호출
    const imports = collectPublishedImports("@soksak/workbench", tmpDir, ["app.js", "app.html"]);

    // transcript.js import이 isDiagnosticsOnly: true로 표시되어야 함
    const diagnosticsOnlyImports = imports.filter(imp => imp.isDiagnosticsOnly);

    assert.ok(diagnosticsOnlyImports.length > 0, "진단 전용 import을 감지해야 함");
    assert.ok(
      diagnosticsOnlyImports.some(imp => imp.resolvedPath.includes("transcript")),
      "transcript.js가 진단 전용으로 표시되어야 함"
    );

    // 이런 import은 missing: true이므로 테스트를 통과하지 못함
    const errors = [];
    for (const imp of imports) {
      if (imp.missing && imp.isDiagnosticsOnly) {
        errors.push(`파일 ${imp.file}이 진단 전용 파일 ${imp.resolvedPath}을 무조건 import하므로 릴리스에서 깨질 것`);
      }
    }

    assert.ok(errors.length > 0, "진단 전용 파일의 무조건 import은 오류를 생성해야 함");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("an unreadable listed file fails the published import check with its path", () => {
  const dir = join(tmpdir(), `fixture-unreadable-${process.pid}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "test-fixture-unreadable", files: ["app.js"] }));
    writeFileSync(join(dir, "app.js"), "export const app = 1;\n");
    chmodSync(join(dir, "app.js"), 0o000);
    assert.throws(() => collectPublishedImports("test-fixture-unreadable", dir, ["app.js"]), /EACCES.*app\.js/);
  } finally {
    chmodSync(join(dir, "app.js"), 0o644);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unparsable package.json fails the package discovery with its path", () => {
  const base = join(tmpdir(), `fixture-packages-${process.pid}-${Date.now()}`);
  mkdirSync(join(base, "packages", "broken"), { recursive: true });
  mkdirSync(join(base, "plugins"), { recursive: true });
  try {
    writeFileSync(join(base, "packages", "broken", "package.json"), "{");
    assert.throws(() => getSourceFolders(base), /packages\/broken\/package\.json/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
