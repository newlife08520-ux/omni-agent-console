/**
 * Phase 2.7：從 log 解析延遲（stdin 或檔案）
 *   npx tsx server/scripts/query-latency-stats.ts [path/to.log]
 *   Get-Content app.log | npx tsx server/scripts/query-latency-stats.ts
 */
import fs from "fs";
import readline from "readline";

const RE_NUM = /(-?\d+(?:\.\d+)?)/g;

function parseKey(line: string, key: string): number | null {
  const m = line.match(new RegExp(`${key}=(-?\\d+)`));
  return m ? parseInt(m[1], 10) : null;
}

function parseBracketKey(line: string, key: string): number | null {
  return parseKey(line, key);
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function summarize(name: string, vals: number[]): void {
  if (vals.length === 0) {
    console.log(`  ${name}: (no samples)`);
    return;
  }
  const s = [...vals].sort((a, b) => a - b);
  const p50 = percentile(s, 50);
  const p95 = percentile(s, 95);
  const mx = s[s.length - 1];
  console.log(`  ${name}: n=${vals.length} p50=${p50} p95=${p95} max=${mx}`);
}

async function main() {
  const arg = process.argv[2];
  const input = arg && arg !== "-" ? fs.createReadStream(arg) : process.stdin;

  const rl = readline.createInterface({ input, crlfDelay: Infinity });

  const lookupAck: number[] = [];
  const firstVisible: number[] = [];
  const finalReply: number[] = [];
  const queueWait: number[] = [];
  const toolMs = new Map<string, number[]>();
  const byRenderer = new Map<string, number[]>();
  const byProfile = new Map<string, number[]>();

  for await (const line of rl) {
    if (line.includes("lookup_ack_sent_ms=")) {
      const v = parseBracketKey(line, "lookup_ack_sent_ms");
      if (v != null) lookupAck.push(v);
    }
    if (line.includes("first_customer_visible_reply_ms=")) {
      const v = parseBracketKey(line, "first_customer_visible_reply_ms");
      if (v != null) firstVisible.push(v);
    }
    if (line.includes("final_reply_sent_ms=")) {
      const v = parseBracketKey(line, "final_reply_sent_ms");
      if (v != null) finalReply.push(v);
    }
    if (line.includes("queue_wait_ms=")) {
      const v = parseBracketKey(line, "queue_wait_ms");
      if (v != null && v >= 0) queueWait.push(v);
    }
    const toolM = line.match(/tool\s+(\S+)\s+ms\s+(\d+)/);
    if (toolM) {
      const name = toolM[1];
      const ms = parseInt(toolM[2], 10);
      if (!toolMs.has(name)) toolMs.set(name, []);
      toolMs.get(name)!.push(ms);
    }
    const fr = line.match(/final_renderer=(\S+)/);
    if (fr && line.includes("final_reply_sent_ms=")) {
      const v = parseBracketKey(line, "final_reply_sent_ms");
      if (v != null) {
        const r = fr[1].replace(/[^\w-]/g, "");
        if (!byRenderer.has(r)) byRenderer.set(r, []);
        byRenderer.get(r)!.push(v);
      }
    }
    const pp = line.match(/prompt_profile=(\S+)/);
    if (pp && line.includes("final_reply_sent_ms=")) {
      const v = parseBracketKey(line, "final_reply_sent_ms");
      if (v != null) {
        const p = pp[1].replace(/[^\w_-]/g, "");
        if (!byProfile.has(p)) byProfile.set(p, []);
        byProfile.get(p)!.push(v);
      }
    }
  }

  console.log("# Phase 27 latency summary (ms)\n");
  summarize("lookup_ack_sent_ms", lookupAck);
  summarize("first_customer_visible_reply_ms", firstVisible);
  summarize("final_reply_sent_ms", finalReply);
  summarize("queue_wait_ms", queueWait);
  console.log("\n# By tool (reply ms field = tool execution)");
  for (const [k, v] of [...toolMs.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    summarize(`tool:${k}`, v);
  }
  console.log("\n# final_reply_sent_ms by final_renderer");
  for (const [k, v] of [...byRenderer.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    summarize(k, v);
  }
  console.log("\n# final_reply_sent_ms by prompt_profile");
  for (const [k, v] of [...byProfile.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    summarize(k, v);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
