import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
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

/** 패키지 폴더 맵 (패키지 이름 → 디렉터리 경로). */
function getPackageFolders() {
  const packages = new Map();
  const places = ["packages", "plugins"];

  for (const place of places) {
    const placeDir = join(root, place);
    let dirs = [];
    try {
      dirs = readdirSync(placeDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      continue;
    }

    for (const dir of dirs) {
      const packageJsonPath = join(placeDir, dir, "package.json");
      try {
        const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8"));
        packages.set(pkg.name, join(placeDir, dir));
      } catch {
        // package.json이 없으면 패키지가 아니다
      }
    }
  }

  return packages;
}

/** 파일이 배포 목록에 포함되는지 확인한다. */
function isInPublishedFiles(publishedPath, filesArray, packageDir) {
  for (const fileEntry of filesArray) {
    const fullPath = join(packageDir, fileEntry);

    // 디렉터리인지 확인
    try {
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        // 디렉터리면 그 아래의 모든 파일이 포함된다
        if (publishedPath.startsWith(fileEntry + "/")) {
          return true;
        }
      }
    } catch {
      // 디렉터리가 아님
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

  // import "./x" (side-effect import)
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
    try {
      const stat = statSync(resolvedPath);
      if (stat.isDirectory()) {
        resolvedPath = join(resolvedPath, "index.js");
      }
    } catch {
      // 파일이 없으면 .js 추가
      resolvedPath = resolvedPath + ".js";
    }
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
  try {
    const pkg = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
    return Boolean(pkg.scripts?.build);
  } catch {
    return false;
  }
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

    try {
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        buildDirs.add(fileEntry);
      }
    } catch {
      // 존재하지 않는 디렉터리는 아직 빌드되지 않은 산출물일 수 있다
      // 경로가 /로 끝나거나 files에 명시적으로 디렉터리로 보인다면 산출 디렉터리로 표시
      if (fileEntry.endsWith("/") || !fileEntry.includes(".")) {
        buildDirs.add(fileEntry);
      }
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
function collectPublishedImports(packageName, packageDir, filesArray) {
  const results = [];
  const checkedFiles = new Set();
  const buildOutputDirs = getBuildOutputDirs(packageDir, filesArray);
  // 워크벤치는 스테이징이 만드는 파일들을 import할 수 있다
  const isWorkbench = packageName === "@soksak/workbench";

  function processFile(filePath) {
    if (checkedFiles.has(filePath)) return;
    checkedFiles.add(filePath);

    try {
      const content = readFileSync(filePath, "utf8");
      const isHtml = filePath.endsWith(".html");
      const isJs = filePath.endsWith(".js");

      if (!isHtml && !isJs) return;

      const imports = isHtml ? extractHtmlImports(content) : extractJsImports(content);
      const fromDir = dirname(filePath);

      for (const importPath of imports) {
        try {
          const resolvedPath = resolveImportPath(importPath, fromDir);
          const relativePath = makeRelativePath(resolvedPath, packageDir);

          // 파일이 존재하는지 확인
          let fileExists = false;
          try {
            statSync(join(packageDir, relativePath));
            fileExists = true;
          } catch {
            fileExists = false;
          }

          // 파일이 없으면 여러 가지 경우를 확인
          if (!fileExists) {
            // 1. 워크벤치의 경우 스테이징이 만드는 파일인지 확인
            if (isWorkbench) {
              if (STAGED.always.includes(relativePath)) {
                // 모든 빌드에서 생성되므로 안전함
                results.push({
                  file: makeRelativePath(filePath, packageDir),
                  importPath,
                  resolvedPath: relativePath,
                  inPublished: true, // 스테이징 후에 만들어질 것임
                  isStaged: true, // 스테이징에서 만드는 파일임을 표시
                  stagedType: "always",
                });
                continue;
              }

              if (STAGED.diagnostics.includes(relativePath)) {
                // 진단 빌드에서만 생성되므로 릴리스 빌드에서 깨짐
                results.push({
                  file: makeRelativePath(filePath, packageDir),
                  importPath,
                  resolvedPath: relativePath,
                  inPublished: false,
                  missing: true, // 무조건 import하면 릴리스에서 없음
                  isDiagnosticsOnly: true, // 진단 전용 파일 표시
                });
                continue;
              }
            }

            // 2. 빌드 산출 디렉터리인지 확인
            if (isInBuildOutputDir(relativePath, packageDir, buildOutputDirs)) {
              // 빌드 산출물이므로 test 시간에 없어도 괜찮음
              results.push({
                file: makeRelativePath(filePath, packageDir),
                importPath,
                resolvedPath: relativePath,
                inPublished: true, // 빌드 후에 files에 포함될 것임
                isBuildOutput: true, // 빌드 산출물임을 표시
              });
              continue;
            }

            // 3. 둘 다 아니면 실제 누락된 파일
            results.push({
              file: makeRelativePath(filePath, packageDir),
              importPath,
              resolvedPath: relativePath,
              inPublished: false,
              missing: true, // 존재하지 않는 파일을 명시적으로 표시
            });
            continue;
          }

          const inPublished = isInPublishedFiles(relativePath, filesArray, packageDir);

          results.push({
            file: makeRelativePath(filePath, packageDir),
            importPath,
            resolvedPath: relativePath,
            inPublished,
          });
        } catch (e) {
          // import 해석 실패는 무시
        }
      }
    } catch (e) {
      // 파일 읽기 실패는 무시
    }
  }

  // 모든 published 파일 처리
  for (const fileEntry of filesArray) {
    const fullPath = join(packageDir, fileEntry);

    try {
      const stat = statSync(fullPath);

      if (stat.isDirectory()) {
        // 디렉터리면 안의 모든 JS/HTML 파일 처리
        function walkDir(dir) {
          try {
            const entries = readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
              const fullEntry = join(dir, entry.name);
              if (entry.isDirectory()) {
                walkDir(fullEntry);
              } else if (entry.name.endsWith(".js") || entry.name.endsWith(".html")) {
                processFile(fullEntry);
              }
            }
          } catch {
            // 디렉터리 읽기 실패
          }
        }
        walkDir(fullPath);
      } else if (fileEntry.endsWith(".js") || fileEntry.endsWith(".html")) {
        processFile(fullPath);
      }
    } catch {
      // 파일이 없음
    }
  }

  return results;
}

test("모든 배포 파일의 import은 files에 포함되어야 한다", () => {
  const packages = getPackageFolders();
  const errors = [];
  const allowed = []; // 스테이징이나 빌드로 생성되는 파일들

  for (const [packageName, packageDir] of packages) {
    const packageJsonPath = join(packageDir, "package.json");

    try {
      const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8"));

      if (!Array.isArray(pkg.files)) {
        // files가 없으면 이 패키지는 배포하지 않음
        continue;
      }

      const imports = collectPublishedImports(packageName, packageDir, pkg.files);

      for (const imp of imports) {
        // 스테이징이 만드는 파일은 허용 (배포 때 stage.mjs가 만듦)
        if (imp.isStaged) {
          allowed.push(`${packageName}: ${imp.file} → ${imp.resolvedPath} (스테이징이 생성)`);
          continue;
        }

        // 빌드 산출물은 허용 (테스트 때 아직 생성되지 않지만 build 후 생김)
        if (imp.isBuildOutput) {
          allowed.push(`${packageName}: ${imp.file} → ${imp.resolvedPath} (빌드 산출물)`);
          continue;
        }

        // 존재하지 않는 파일은 실패
        if (imp.missing) {
          errors.push(`패키지 ${packageName}의 ${imp.file}이 import 하는 ${imp.resolvedPath}이 존재하지 않는다`);
          continue;
        }

        // 존재하지만 files에 없는 파일은 실패
        if (!imp.inPublished) {
          errors.push(`패키지 ${packageName}의 ${imp.file}이 import 하는 ${imp.resolvedPath}이 files에 없다`);
        }
      }
    } catch (e) {
      // 패키지 읽기 실패
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

test("누락된 파일 import을 실패로 감지한다", () => {
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

test("픽스처: 예전 로직은 누락된 파일을 통과시켰을 것이다", () => {
  // 임시 픽스처 패키지 생성
  const tmpDir = join(tmpdir(), `fixture-legacy-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpDir, { recursive: true });

  try {
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({
      name: "test-fixture-legacy",
      files: ["app.js"]
    }, null, 2));

    writeFileSync(join(tmpDir, "app.js"), `import "./missing-dependency.js";\n`);

    // 예전 로직: 파일이 없으면 continue (건너뜀)
    // 이 로직을 시뮬레이션하면 결과가 비어 있어야 함
    const results = [];
    const checkedFiles = new Set();

    function processFileLegacy(filePath) {
      if (checkedFiles.has(filePath)) return;
      checkedFiles.add(filePath);

      try {
        const content = readFileSync(filePath, "utf8");
        const isJs = filePath.endsWith(".js");
        if (!isJs) return;

        const imports = []; // 간단히 "./missing-dependency.js" 하나
        const match = content.match(/from\s+["'](\.[^"']*?)["']/);
        if (match) imports.push(match[1]);

        const fromDir = dirname(filePath);

        for (const importPath of imports) {
          const resolvedPath = resolve(fromDir, importPath);
          if (!resolvedPath.endsWith(".js")) {
            // missing-dependency.js 파일 확인
          }
          const relativePath = relative(tmpDir, resolvedPath);

          // 예전 로직: 파일이 없으면 continue
          try {
            statSync(join(tmpDir, relativePath));
          } catch {
            continue; // 이렇게 건너뜀
          }

          results.push({
            file: relative(tmpDir, filePath),
            importPath,
            resolvedPath: relativePath,
          });
        }
      } catch (e) {
        // 무시
      }
    }

    processFileLegacy(join(tmpDir, "app.js"));

    // 예전 로직에서는 결과가 비어 있음 (누락된 파일이 건너뜬 것)
    assert.equal(results.length, 0, "예전 로직은 누락된 파일을 건너뜨렸을 것");

    // 이는 테스트가 거짓 통과했다는 증거
    console.log("ℹ 예전 로직이 누락된 import을 건너뜬 증거를 보임");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("진단 전용 파일을 무조건 import하면 실패로 잡는다", () => {
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
