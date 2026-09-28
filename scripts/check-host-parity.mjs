// 두 호스트의 공개 API 면을 기계로 비교한다(docs/spec/host-parity.md).
//
// 명제 1(공개 바인딩)은 각 프론트엔드 런타임이 받아들이는 host.call 이름 집합과 그 이름이 각 호스트
// 구현에 실제로 연결되는지를 검사한다. 명제 2(엔드포인트 메서드)는 각 호스트가 선언하는 엔드포인트
// 메서드 집합을 빌드 맛별로 비교한다. 차이가 하나라도 있으면 실패하고, 실패 목록이 차이 보고서다.
// 명제 3(실제 메뉴 바)은 실창 검사가, 명제 4·5는 이 도구의 다음 확장이 담당한다.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

/** 카멜 케이스 메서드 이름을 스네이크 케이스로 바꾼다. 바인딩 이름 비교의 정규형이다. */
export const snake = (name) => name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/([A-Z])([A-Z][a-z])/g, '$1_$2').toLowerCase();

/** 런타임의 호출 이름 표(COMMAND, METHOD)에서 host.call 이름 집합을 읽는다. */
export function runtimeCalls(runtime, tableDeclaration, file) {
  const table = runtime.indexOf(tableDeclaration);
  if (table < 0) throw new Error(`${file} has no ${tableDeclaration} table`);
  const body = runtime.slice(table, runtime.indexOf('};', table));
  return new Set([...body.matchAll(/([a-z][a-zA-Z0-9]*):\s*"/g)].map((match) => snake(match[1])));
}

/** Rust generate_handler! 의 명령 이름 집합. */
export function rustHandlers(bindings) {
  const start = bindings.indexOf('generate_handler![');
  if (start < 0) throw new Error('bindings.rs has no generate_handler!');
  return new Set(bindings.slice(start, bindings.indexOf(']', start))
    .split(/[\s,]+/).filter((name) => /^[a-z][a-z0-9_]*$/.test(name)));
}

/** Go 호스트 패키지 전체에서 바인딩된 Host 구조체의 내보낸 메서드 이름 집합. */
export function goHostMethods(sources) {
  const methods = new Set();
  for (const [file, source] of Object.entries(sources)) {
    for (const match of source.matchAll(/^func \(h \*Host\) ([A-Z]\w*)\(/gm)) methods.add(snake(match[1]));
  }
  return methods;
}

/** Rust 엔드포인트가 선언하는 메서드 이름 집합(빌드 맛별). */
export function rustEndpointMethods(source) {
  const collect = (name) => {
    const declaration = `const ${name}: &[&str] = &[`;
    const start = source.indexOf(declaration);
    if (start < 0) throw new Error(`endpoint.rs has no ${name} array`);
    const body = source.slice(start + declaration.length, source.indexOf('];', start));
    return new Set(body.split(/[\s,]+/).map((value) => value.replaceAll('"', '')).filter((value) => value.includes('.')));
  };
  const diagnostics = collect('DIAGNOSTICS');
  // 진단 빌드의 transcript 메서드는 상수 이름으로 배열에 들어가 있으므로 상수 선언에서 얻는다.
  const transcript = source.match(/const TRANSCRIPT: &str = "([a-z][a-z0-9_.]*)"/);
  if (transcript) diagnostics.add(transcript[1]);
  return { base: collect('METHODS'), diagnostics };
}

function goMapKeys(source, declaration) {
  const start = source.indexOf(declaration);
  if (start < 0) throw new Error(`source has no ${declaration}`);
  const body = source.slice(start, source.indexOf('\n}', start));
  return new Set([...body.matchAll(/"([a-z][a-z0-9_.]*)":/g)].map((match) => match[1]));
}

/** Go 엔드포인트가 선언하는 메서드 이름 집합(빌드 맛별). */
export function goEndpointMethods(endpoint, diagnosticsSource) {
  const assigned = (source) => [...source.matchAll(/^\s*diagnostic(Methods|Subscriptions)\["([a-z][a-z0-9_.]*)"\] =/gm)]
    .map((match) => match[2]);
  const diagnosticOnly = new Set([
    ...assigned(diagnosticsSource),
    ...goMapKeys(endpoint, 'var diagnosticSubscriptions = map[string]subscriptionMethod{'),
  ]);
  const base = new Set([
    ...goMapKeys(endpoint, 'var endpointMethods = map[string]endpointMethod{'),
    ...goMapKeys(endpoint, 'var subscriptionMethods = map[string]subscriptionMethod{'),
    ...assigned(diagnosticsSource),
  ]);
  for (const name of diagnosticOnly) base.delete(name);
  return { base, diagnostics: diagnosticOnly };
}

/** 주입된 소스에 대해 명제 1·2를 판정하고 실패 목록을 돌려준다. */
export function auditHostParity({ tauriv2Runtime, tauriv2Bindings, wailsv3Runtime, wailsv3HostSources,
  tauriv2EndpointSource, wailsv3EndpointSource, wailsv3DiagnosticsSource }) {
  const failures = [];
  const tauriv2 = {
    calls: runtimeCalls(tauriv2Runtime, 'const COMMAND = {', 'tauriv2 runtime'),
    handlers: rustHandlers(tauriv2Bindings),
  };
  const wailsv3 = {
    calls: runtimeCalls(wailsv3Runtime, 'const METHOD = {', 'wailsv3 runtime'),
    methods: goHostMethods(wailsv3HostSources),
  };
  for (const name of [...tauriv2.calls].filter((item) => !wailsv3.calls.has(item)).sort()) {
    failures.push(`tauriv2 host.call(${name}) does not exist on wailsv3`);
  }
  for (const name of [...wailsv3.calls].filter((item) => !tauriv2.calls.has(item)).sort()) {
    failures.push(`wailsv3 host.call(${name}) does not exist on tauriv2`);
  }
  for (const name of [...tauriv2.calls].filter((item) => !tauriv2.handlers.has(item)).sort()) {
    failures.push(`tauriv2 host.call(${name}) has no registered handler`);
  }
  for (const name of [...wailsv3.calls].filter((item) => !wailsv3.methods.has(item)).sort()) {
    failures.push(`wailsv3 host.call(${name}) has no Host method`);
  }
  const endpointT = rustEndpointMethods(tauriv2EndpointSource);
  const endpointW = goEndpointMethods(wailsv3EndpointSource, wailsv3DiagnosticsSource);
  for (const [name, left, right] of [
    ['endpoint base methods', endpointT.base, endpointW.base],
    ['endpoint diagnostics methods', endpointT.diagnostics, endpointW.diagnostics],
  ]) {
    for (const method of [...left].filter((item) => !right.has(item)).sort()) {
      failures.push(`tauriv2 ${name} has "${method}" that wailsv3 does not`);
    }
    for (const method of [...right].filter((item) => !left.has(item)).sort()) {
      failures.push(`wailsv3 ${name} has "${method}" that tauriv2 does not`);
    }
  }
  return failures;
}

if (process.argv[1] && process.argv[1].endsWith('check-host-parity.mjs')) {
  const read = (path) => readFileSync(join(ROOT, path), 'utf8');
  const wailsv3Sources = {};
  for (const file of readdirSync(join(ROOT, 'packages/host/wailsv3/src'))) {
    if (file.endsWith('.go') && !file.endsWith('_test.go')) {
      wailsv3Sources[file] = read(join('packages/host/wailsv3/src', file));
    }
  }
  const failures = auditHostParity({
    tauriv2Runtime: read('apps/tauriv2/src/frontend/runtime/index.js'),
    tauriv2Bindings: read('packages/host/tauriv2/src/bindings.rs'),
    wailsv3Runtime: read('apps/wailsv3/src/frontend/runtime/index.js'),
    wailsv3HostSources: wailsv3Sources,
    tauriv2EndpointSource: read('packages/host/tauriv2/src/endpoint.rs'),
    wailsv3EndpointSource: read('packages/host/wailsv3/src/endpoint.go'),
    wailsv3DiagnosticsSource: read('packages/host/wailsv3/src/diagnostics.go'),
  });
  for (const failure of failures) console.error(`FAIL: ${failure}`);
  if (failures.length > 0) {
    console.error(`host parity: ${failures.length} difference(s)`);
    process.exit(1);
  }
  console.log('Host parity passed: host.call names, handler wiring, and endpoint method sets are equal');
}
