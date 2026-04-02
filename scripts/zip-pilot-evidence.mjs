import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NAME = "PHASE1_PILOT_FUNCTIONAL_EVIDENCE";
const parent = path.join(root, "_PILOT_EVIDENCE_ZIP_STAGING");
const stage = path.join(parent, NAME);
const jsonSrc = path.join(root, "_evidence_run", "phase16", "pilot_ai_logs_evidence.json");
const traceSrc = path.join(root, "_evidence_run", "phase16", "phase16_trace_summary_redacted.json");
const outZip = path.join(root, `${NAME}.zip`);
const readme = path.join(root, "README_PILOT_EVIDENCE.md");

fs.rmSync(parent, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });
if (!fs.existsSync(jsonSrc)) {
  console.error("missing", jsonSrc);
  process.exit(1);
}
fs.copyFileSync(jsonSrc, path.join(stage, "pilot_ai_logs_evidence.json"));
if (fs.existsSync(traceSrc)) {
  fs.copyFileSync(traceSrc, path.join(stage, "phase16_trace_summary_redacted.json"));
}
if (fs.existsSync(readme)) fs.copyFileSync(readme, path.join(stage, "README_PILOT_EVIDENCE.md"));
fs.rmSync(outZip, { force: true });
const r = spawnSync("tar.exe", ["-a", "-c", "-f", outZip, "-C", parent, NAME], { encoding: "utf8" });
if (r.status !== 0) process.exit(r.status ?? 1);
console.log("Wrote", outZip);
