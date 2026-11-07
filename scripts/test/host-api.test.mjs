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
});
