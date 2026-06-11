const fs = require("fs");
const path = require("path");
const axios = require("axios");

const BASE_URL = process.env.BENCH_BASE_URL || "https://hansaria-app-backend.onrender.com";
const USERNAME = process.env.BENCH_USER || "admin";
const PASSWORD = process.env.BENCH_PASS || "1234";
const DURATION_SEC = Number(process.env.BENCH_DURATION_SEC || 20);
const CONCURRENCY_LEVELS = (process.env.BENCH_CONCURRENCY || "25,50,100")
  .split(",")
  .map((n) => Number(n.trim()))
  .filter((n) => Number.isFinite(n) && n > 0);

const ENDPOINTS = [
  { name: "Cash Entries", method: "get", url: "/api/cash-entries" },
  { name: "Warehouses", method: "get", url: "/api/warehouses" },
  { name: "Party Stock Report", method: "get", url: "/api/reports/party-stock" },
];

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function toFixed2(n) {
  return Number(n || 0).toFixed(2);
}

function formatAxiosError(err) {
  if (!err) return "Unknown error";
  if (err.response) {
    const status = err.response.status;
    const data = err.response.data;
    const details = typeof data === "string" ? data : JSON.stringify(data);
    return `HTTP ${status} - ${details}`;
  }
  if (err.code) {
    return `${err.code}${err.message ? ` - ${err.message}` : ""}`;
  }
  return err.message || String(err);
}

async function ensureServerReachable() {
  try {
    await axios.get(`${BASE_URL}/`, { timeout: 5000 });
  } catch (err) {
    throw new Error(
      `Cannot reach backend at ${BASE_URL}. Start backend first (e.g. npm start). Details: ${formatAxiosError(err)}`
    );
  }
}

async function login() {
  try {
    const res = await axios.post(
      `${BASE_URL}/auth/login`,
      { username: USERNAME, password: PASSWORD },
      { timeout: 15000 }
    );
    const token = res?.data?.token;
    if (!token) throw new Error("Login succeeded but token missing");
    return token;
  } catch (err) {
    throw new Error(`Login failed for user '${USERNAME}'. ${formatAxiosError(err)}`);
  }
}

async function runLoad({ token, endpoint, concurrency, durationSec }) {
  const headers = { Authorization: `Bearer ${token}` };
  const latencies = [];
  let success = 0;
  let failed = 0;
  let started = 0;

  const endAt = Date.now() + durationSec * 1000;

  async function worker() {
    while (Date.now() < endAt) {
      started += 1;
      const t0 = Date.now();
      try {
        await axios({
          method: endpoint.method,
          url: `${BASE_URL}${endpoint.url}`,
          headers,
          timeout: 20000,
        });
        success += 1;
      } catch (err) {
        failed += 1;
      } finally {
        latencies.push(Date.now() - t0);
      }
    }
  }

  const start = Date.now();
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  const elapsedMs = Date.now() - start;
  const sorted = [...latencies].sort((a, b) => a - b);
  const avg = sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : 0;

  return {
    endpoint: endpoint.name,
    path: endpoint.url,
    concurrency,
    duration_sec: durationSec,
    total_requests: started,
    success,
    failed,
    error_rate_pct: started ? (failed * 100) / started : 0,
    rps: elapsedMs ? (started * 1000) / elapsedMs : 0,
    latency_ms: {
      p50: percentile(sorted, 50),
      p95: percentile(sorted, 95),
      p99: percentile(sorted, 99),
      avg,
      max: sorted.length ? sorted[sorted.length - 1] : 0,
    },
  };
}

function printTable(results) {
  const rows = results.map((r) => ({
    Endpoint: r.endpoint,
    Concurrency: r.concurrency,
    RPS: toFixed2(r.rps),
    "Error %": toFixed2(r.error_rate_pct),
    "P50(ms)": toFixed2(r.latency_ms.p50),
    "P95(ms)": toFixed2(r.latency_ms.p95),
    "P99(ms)": toFixed2(r.latency_ms.p99),
    "Avg(ms)": toFixed2(r.latency_ms.avg),
    "Max(ms)": toFixed2(r.latency_ms.max),
  }));
  console.table(rows);
}

function toMarkdown(results) {
  const lines = [];
  lines.push(`# Capacity Benchmark (${new Date().toISOString()})`);
  lines.push("");
  lines.push(`- Base URL: \`${BASE_URL}\``);
  lines.push(`- Duration per test: \`${DURATION_SEC}s\``);
  lines.push(`- Concurrency levels: \`${CONCURRENCY_LEVELS.join(", ")}\``);
  lines.push("");
  lines.push("| Endpoint | Conc | RPS | Error % | P50 ms | P95 ms | P99 ms | Avg ms | Max ms |");
  lines.push("|---|---:|---:|---:|---:|---:|---:|---:|---:|");
  for (const r of results) {
    lines.push(
      `| ${r.endpoint} | ${r.concurrency} | ${toFixed2(r.rps)} | ${toFixed2(r.error_rate_pct)} | ${toFixed2(
        r.latency_ms.p50
      )} | ${toFixed2(r.latency_ms.p95)} | ${toFixed2(r.latency_ms.p99)} | ${toFixed2(r.latency_ms.avg)} | ${toFixed2(r.latency_ms.max)} |`
    );
  }
  lines.push("");
  return lines.join("\n");
}

async function main() {
  console.log(`Benchmark start: ${BASE_URL}`);
  await ensureServerReachable();
  const token = await login();
  const results = [];

  for (const concurrency of CONCURRENCY_LEVELS) {
    for (const endpoint of ENDPOINTS) {
      console.log(`Running ${endpoint.name} at concurrency=${concurrency} for ${DURATION_SEC}s ...`);
      const result = await runLoad({
        token,
        endpoint,
        concurrency,
        durationSec: DURATION_SEC,
      });
      results.push(result);
    }
  }

  printTable(results);

  const outDir = path.join(__dirname, "..", "benchmark-results");
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const jsonPath = path.join(outDir, `capacity-${stamp}.json`);
  const mdPath = path.join(outDir, `capacity-${stamp}.md`);
  fs.writeFileSync(jsonPath, JSON.stringify(results, null, 2), "utf8");
  fs.writeFileSync(mdPath, toMarkdown(results), "utf8");
  console.log(`Saved: ${jsonPath}`);
  console.log(`Saved: ${mdPath}`);
}

main().catch((err) => {
  console.error("Benchmark failed:", err.message);
  process.exit(1);
});
