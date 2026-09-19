import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import test from "node:test";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

/** 모든 배포 파일 스캔 */
function collectPublishedImports(packageName, packageDir, filesArray) {
  const results = [];
  const checkedFiles = new Set();

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

          // 파일이 존재하지 않으면 건너뛴다 (생성된 파일 등)
          try {
            statSync(join(packageDir, relativePath));
          } catch {
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
        if (!imp.inPublished) {
          errors.push(`패키지 ${packageName}의 ${imp.file}이 import 하는 ${imp.resolvedPath}이 files에 없다`);
        }
      }
    } catch (e) {
      // 패키지 읽기 실패
    }
  }

  if (errors.length > 0) {
    assert.fail(errors.join("\n"));
  }
});
