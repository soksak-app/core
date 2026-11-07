import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("native host API bindings follow the declared C functions and reject unsupported signatures",{timeout:30000},async()=>{
 const {createHostApi}=await import("../check-host-api.mjs");
 const folder=mkdtempSync(join(tmpdir(),"host-api-"));
 try{
  const header=join(folder,"host_api.h");
  writeFileSync(header,"#include <stdint.h>\n#include <stdbool.h>\ntypedef struct { uint64_t count; const char *message; } sp_result;\nbool readResult(uintptr_t token, sp_result *out);\nvoid diagnose(int value);\n");
  const result=createHostApi(header,{core:["readResult"],diagnostics:["diagnose"],records:["sp_result"],constants:[]});
  assert.match(result.shared,/type NativeFunctions struct/);
  assert.match(result.shared,/ReadResult\s+func\(uintptr, \*SpResult\) bool/);
  assert.match(result.shared,/Count\s+uint64/);
  assert.match(result.shared,/Message\s+\*byte/);
  assert.doesNotMatch(result.shared,/import "C"|purego/);
  assert.match(result.wails,/C\.readResult/);
  assert.match(result.mygo,/readResult/);
  assert.match(result.sharedDiagnostics,/Diagnose\s+func\(int32\)/);
  assert.doesNotMatch(result.shared,/Diagnose/);
  writeFileSync(header,"void broken(long double value);\n");
  assert.throws(()=>createHostApi(header,{core:["broken"],diagnostics:[],records:[],constants:[]}),/unsupported.*long double/);
 }finally{rmSync(folder,{recursive:true});}
});


test("native API test bindings belong to the standalone bootstrap package", async () => {
 const {hostApiOutputPaths}=await import("../check-host-api.mjs");
 const paths=hostApiOutputPaths();
 assert.ok(paths.some(([key,path])=>key==="wails"&&path==="packages/host/go/tests/platform/darwin/standalone/bindings/native_api.go"));
 assert.ok(paths.some(([key,path])=>key==="wailsDiagnostics"&&path==="packages/host/go/tests/platform/darwin/standalone/bindings/native_api_diagnostics.go"));
 assert.equal(paths.some(([,path])=>path.startsWith("packages/host/go/tests/platform/darwin/bindings/")),false);
 for (const path of [
  "packages/host/go/tests/platform/darwin/standalone/dynamic/native_api.go",
  "packages/host/go/tests/platform/darwin/standalone/dynamic/native_api_diagnostics.go",
  "packages/host/go/tests/platform/darwin/abi/native_api.go",
  "packages/host/go/tests/platform/darwin/standalone/testbindings/native_api.go",
  "packages/host/go/tests/platform/darwin/standalone/testdynamic/native_api.go",
  "packages/host/mygo/tests/platform/darwin/bindings/native_api.go",
 ]) assert.ok(paths.some(([,output])=>output===path), `missing declared output ${path}`);
});

test("native test APIs use their own ABI namespace and pkg-config declaration without changing production defaults", {timeout:30000}, async () => {
 const {createHostApi}=await import("../check-host-api.mjs");
 const folder=mkdtempSync(join(tmpdir(),"host-test-api-"));
 try {
  const header=join(folder,"host_test_api.h");
  writeFileSync(header,"#include <stdint.h>\ntypedef struct { uint64_t samples; } sp_test_counts;\nvoid sp_host_test_read(sp_test_counts *counts);\nvoid sp_host_test_diagnose(uintptr_t context);\n");
  const manifest={core:["sp_host_test_read"],diagnostics:["sp_host_test_diagnose"],records:["sp_test_counts"],constants:[]};
  const abiImport="github.com/soksak-app/core/packages/host/go/tests/platform/darwin/abi";
  const result=createHostApi(header,manifest,{abiImport,pkgConfig:"soksak-host-test"});
  for (const key of ["wails","wailsDiagnostics","mygo","mygoDiagnostics"]) {
   assert.ok(result[key].includes(`abi "${abiImport}"`), `${key} uses the test ABI`);
   assert.doesNotMatch(result[key], /packages\/host\/go\/src\/platform\/darwin\/abi/);
  }
  for (const key of ["wails","wailsDiagnostics"]) {
   assert.match(result[key], /#cgo pkg-config: soksak-host-test\n/);
   assert.match(result[key], /#include "host_test_api\.h"/);
  }
  assert.match(result.shared, /type SpTestCounts struct/);
  assert.match(result.mygo, /func Functions\(library uintptr\)/);
  const defaults=createHostApi(header,manifest);
  assert.match(defaults.wails, /#cgo pkg-config: soksak-darwin\n/);
  assert.match(defaults.mygo, /packages\/host\/go\/src\/platform\/darwin\/abi/);
 } finally {rmSync(folder,{recursive:true});}
});
