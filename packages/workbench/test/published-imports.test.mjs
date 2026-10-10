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

/** Returns null only when the file does not exist. Any other error is thrown with the path attached. */
function statOrNull(path) {
  try {
    return statSync(path);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error(`${path}: ${error.message}`, { cause: error });
  }
}

/** Reads the file. On failure it throws with the path attached. */
function readText(path) {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`${path}: ${error.message}`, { cause: error });
  }
}

/** Reads a JSON file. If it cannot be read or parsed, it throws with the path attached. */
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
  // A plugin lives in its own repository (docs/spec/plugins.md#repositories).
  const places = ["packages"];

  for (const place of places) {
    const placeDir = join(base, place);
    const dirs = readdirSync(placeDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);

    for (const dir of dirs) {
      const packageJsonPath = join(placeDir, dir, "package.json");
      // A folder without package.json is not an npm package. If package.json exists but cannot be read, the test fails.
      if (!statOrNull(packageJsonPath)) continue;
      packages.set(readJson(packageJsonPath).name, join(placeDir, dir));
    }
  }

  return packages;
}

/** Checks whether a file is included in the publish list. */
function isInPublishedFiles(publishedPath, filesArray, packageDir) {
  for (const fileEntry of filesArray) {
    const fullPath = join(packageDir, fileEntry);

    // If the entry is a directory, all files below it are included. An entry that does not exist is not a directory.
    if (statOrNull(fullPath)?.isDirectory() && publishedPath.startsWith(fileEntry + "/")) {
      return true;
    }

    // A file that matches exactly
    if (fileEntry === publishedPath) {
      return true;
    }
  }

  return false;
}

/** Extracts relative import paths from a JavaScript file */
function extractJsImports(content) {
  const imports = [];

  // Finds both the from "..." and the from '...' forms
  const fromRegex = /from\s+["'](\.[^"']*?)["']/g;
  let match;
  while ((match = fromRegex.exec(content)) !== null) {
    const importPath = match[1];
    imports.push(importPath);
  }

  // Side-effect imports of the form import "./x"
  const importSideEffectRegex = /import\s+["'](\.[^"']*?)["']/g;
  while ((match = importSideEffectRegex.exec(content)) !== null) {
    const importPath = match[1];
    imports.push(importPath);
  }

  return [...new Set(imports)]; // Removes duplicates
}

/** Extracts relative import paths from an HTML file */
function extractHtmlImports(content) {
  const imports = [];

  // Imports inside <script type="module">
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

/** Resolves a relative import to an absolute path */
function resolveImportPath(importPath, fromDir) {
  let resolvedPath = resolve(fromDir, importPath);

  // Tries adding .js when there is no extension
  if (!resolvedPath.endsWith(".js") && !resolvedPath.endsWith(".json")) {
    const stat = statOrNull(resolvedPath);
    // A path that does not exist is an import without an extension, so .js is appended.
    if (!stat) resolvedPath = resolvedPath + ".js";
    else if (stat.isDirectory()) resolvedPath = join(resolvedPath, "index.js");
  }

  return resolvedPath;
}

/** Converts an absolute path to a path relative to the package folder */
function makeRelativePath(absolutePath, packageDir) {
  let relPath = relative(packageDir, absolutePath);
  // Converts backslashes to forward slashes
  return relPath.split("\\").join("/");
}

/** Checks whether the package has a build script */
function hasBuildScript(packageDir) {
  return Boolean(readJson(join(packageDir, "package.json")).scripts?.build);
}

/** Builds the list of build output directories. It is based on files in package.json and on the build script. */
function getBuildOutputDirs(packageDir, filesArray) {
  const buildDirs = new Set();

  // Without a build script there is no output directory
  if (!hasBuildScript(packageDir)) {
    return buildDirs;
  }

  for (const fileEntry of filesArray) {
    const fullPath = join(packageDir, fileEntry);

    const stat = statOrNull(fullPath);
    if (stat?.isDirectory()) {
      buildDirs.add(fileEntry);
    } else if (!stat && (fileEntry.endsWith("/") || !fileEntry.includes("."))) {
      // A directory that does not exist is an output that has not been built yet. A path that ends with / or has no extension is an output directory.
      buildDirs.add(fileEntry);
    }
  }

  return buildDirs;
}

/** Checks whether a path is below a build output directory */
function isInBuildOutputDir(resolvedPath, packageDir, buildOutputDirs) {
  for (const dir of buildOutputDirs) {
    const normDir = dir.replace(/\/$/, "");
    if (resolvedPath.startsWith(normDir + "/") || resolvedPath === normDir) {
      return true;
    }
  }
  return false;
}

/** Scans all published files. A file that does not exist is included in the result with missing: true */
function collectPublishedImports(name, packageDir, filesArray) {
  const results = [];
  const checkedFiles = new Set();
  const buildOutputDirs = getBuildOutputDirs(packageDir, filesArray);
  // The workbench can import the files that staging creates
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
      // The workbench can import the files that staging creates in every build.
      if (isWorkbench && STAGED.always.includes(relativePath)) {
        results.push({ file, importPath, resolvedPath: relativePath, inPublished: true, isStaged: true, stagedType: "always" });
        continue;
      }
      // A document that the host provides is a reply of the host, not a staged file.
      if (isWorkbench && STAGED.served.includes(relativePath)) {
        results.push({ file, importPath, resolvedPath: relativePath, inPublished: true, isStaged: true, stagedType: "served" });
        continue;
      }
      // An unconditional import of a file that only the diagnostic build creates is missing in a release.
      if (isWorkbench && STAGED.diagnostics.includes(relativePath)) {
        results.push({ file, importPath, resolvedPath: relativePath, inPublished: false, missing: true, isDiagnosticsOnly: true });
        continue;
      }
      // A build output may not exist yet when the test runs.
      if (isInBuildOutputDir(relativePath, packageDir, buildOutputDirs)) {
        results.push({ file, importPath, resolvedPath: relativePath, inPublished: true, isBuildOutput: true });
        continue;
      }
      results.push({ file, importPath, resolvedPath: relativePath, inPublished: false, missing: true });
    }
  }

  /** Processes all JS/HTML files in the directory. */
  function walkDir(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullEntry = join(dir, entry.name);
      if (entry.isDirectory()) walkDir(fullEntry);
      else if (entry.name.endsWith(".js") || entry.name.endsWith(".html")) processFile(fullEntry);
    }
  }

  // Processes all published files. An entry that does not exist is allowed only when it is a build output; otherwise it is reported as missing.
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
  const allowed = []; // Files that staging or the build generates

  for (const [name, packageDir] of packages) {
    const packageJsonPath = join(packageDir, "package.json");

    {
      const pkg = readJson(packageJsonPath);

      if (!Array.isArray(pkg.files)) {
        // Without files, this package is not published
        continue;
      }

      const imports = collectPublishedImports(name, packageDir, pkg.files);

      for (const imp of imports) {
        // Files that staging creates are allowed (stage.mjs creates them at publish time)
        if (imp.isStaged) {
          allowed.push(`${name}: ${imp.file} → ${imp.resolvedPath} (${imp.stagedType === "served" ? "host 가 제공" : "스테이징이 생성"})`);
          continue;
        }

        // Build outputs are allowed (they are not generated yet during the test but exist after the build)
        if (imp.isBuildOutput) {
          allowed.push(`${name}: ${imp.file} → ${imp.resolvedPath} (빌드 산출물)`);
          continue;
        }

        // A file that does not exist fails
        if (imp.missing) {
          errors.push(`패키지 ${name}의 ${imp.file}이 import 하는 ${imp.resolvedPath}이 존재하지 않는다`);
          continue;
        }

        // A file that exists but is not in files fails
        if (!imp.inPublished) {
          errors.push(`패키지 ${name}의 ${imp.file}이 import 하는 ${imp.resolvedPath}이 files에 없다`);
        }
      }
    }
  }

  // Records the allowed entries in the test output
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
  // Creates a temporary fixture package
  const tmpDir = join(tmpdir(), `fixture-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpDir, { recursive: true });

  try {
    // package.json: includes app.js in files
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({
      name: "test-fixture-missing-import",
      files: ["app.js"]
    }, null, 2));

    // app.js: imports a file that does not exist
    writeFileSync(join(tmpDir, "app.js"), `import "./missing-dependency.js";\n`);

    // Calling collectPublishedImports must return an entry with missing: true
    const imports = collectPublishedImports("test-fixture", tmpDir, ["app.js"]);

    // Finds the entry that has the missing flag
    const missingItems = imports.filter(imp => imp.missing);

    assert.ok(missingItems.length > 0, "누락된 import을 감지해야 함");
    assert.ok(missingItems[0].resolvedPath.includes("missing-dependency"),
      "missing-dependency.js가 누락된 것으로 보고되어야 함");

    // Now the test failure is verified with this result
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
  // transcript.js exists only in the diagnostic build, so the test verifies the import of it.
  // Creates a temporary workbench fixture
  const tmpDir = join(tmpdir(), `fixture-diag-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpDir, { recursive: true });

  try {
    // package.json in the workbench style
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({
      name: "@soksak/workbench",
      files: ["app.js", "app.html"]
    }, null, 2));

    // File 1: a JavaScript file imports a diagnostics-only file
    writeFileSync(join(tmpDir, "app.js"), `import "./transcript.js";\n`);

    // File 2: an HTML file imports a diagnostics-only file (side effect)
    writeFileSync(join(tmpDir, "app.html"), `<script type="module">
import "./transcript.js";
</script>\n`);

    // Calls collectPublishedImports
    const imports = collectPublishedImports("@soksak/workbench", tmpDir, ["app.js", "app.html"]);

    // The transcript.js import must be marked isDiagnosticsOnly: true
    const diagnosticsOnlyImports = imports.filter(imp => imp.isDiagnosticsOnly);

    assert.ok(diagnosticsOnlyImports.length > 0, "진단 전용 import을 감지해야 함");
    assert.ok(
      diagnosticsOnlyImports.some(imp => imp.resolvedPath.includes("transcript")),
      "transcript.js가 진단 전용으로 표시되어야 함"
    );

    // Such an import is missing: true, so the test does not pass it
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
