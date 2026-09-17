// 실행 중인 애플리케이션의 경로별 JSON-RPC 왕복 지연 측정.
//
// 세 경로를 순차 요청으로 잰다.
//   host    windows.list: 호스트만 응답한다
//   page    status.get core.screen: 호스트가 메인 페이지에 중계한다
//   surface status.get core.surface.document: 호스트가 메인 페이지를 거쳐 표면 페이지에 중계한다
//
// 사용법: node bench/application.mjs --config-dir <dir> [--requests <n>] [--json]
import { connect } from "../client.js";

const WARMUP = 200;

function parseArgs(argv) {
  const options = { requests: 2000, json: false, configDir: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") options.json = true;
    else if (arg === "--config-dir") options.configDir = argv[++i];
    else if (arg === "--requests") {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value <= 0) throw new Error(`--requests expects a positive integer, got ${argv[i]}`);
      options.requests = value;
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!options.configDir) throw new Error("--config-dir is required");
  return options;
}

// 오름차순 정렬 배열에서 nearest-rank 백분위수를 구한다. bench/transport.mjs 와 같은 정의다.
function percentile(sorted, p) {
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

async function measure(client, method, params, count) {
  for (let i = 0; i < WARMUP; i += 1) await client.request(method, params);
  const samples = new Float64Array(count);
  for (let i = 0; i < count; i += 1) {
    const start = process.hrtime.bigint();
    await client.request(method, params);
    samples[i] = Number(process.hrtime.bigint() - start) / 1e3;
  }
  samples.sort();
  return { p50: percentile(samples, 50), p90: percentile(samples, 90), p99: percentile(samples, 99) };
}

const options = parseArgs(process.argv.slice(2));
const client = await connect({ configDir: options.configDir });
try {
  const window = (await client.request("windows.list")).find((w) => w.ready)?.window;
  if (!window) throw new Error("no window of the application is ready");
  const surfaces = await client.request("status.get", { window, name: "core.surfaces" });
  const surface = surfaces.find((s) => s.visible && s.exposes?.includes("status core.surface.document"))?.surface;
  if (!surface) throw new Error("no visible surface registered its document");
  const rows = {
    host: await measure(client, "windows.list", undefined, options.requests),
    page: await measure(client, "status.get", { window, name: "core.screen" }, options.requests),
    surface: await measure(client, "status.get", { window, name: "core.surface.document", surface }, options.requests),
  };
  const application = client.endpoint.application;
  if (options.json) {
    console.log(JSON.stringify({ application, requests: options.requests, rows }));
  } else {
    console.log(`${application}, ${options.requests} sequential requests per path (µs)`);
    for (const [name, r] of Object.entries(rows)) {
      console.log(`${name.padEnd(8)} p50 ${r.p50.toFixed(1).padStart(8)}  p90 ${r.p90.toFixed(1).padStart(8)}  p99 ${r.p99.toFixed(1).padStart(8)}`);
    }
  }
} finally {
  client.close();
}
