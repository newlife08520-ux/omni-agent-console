import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NAME = "PHASE1_FUNCTIONAL_EVIDENCE";
const parent = path.join(root, "_FE_ZIP_STAGING");
const stage = path.join(parent, NAME);
const srcDir = path.join(root, "_evidence_run", "phase15");
const outZip = path.join(root, `${NAME}.zip`);
const readmeRoot = path.join(root, "README_EVIDENCE_CAPTURE.md");
const readmeFallback = path.join(srcDir, "README_EVIDENCE_CAPTURE.md");

fs.rmSync(parent, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });

const jsonSrc = path.join(srcDir, "phase15_ai_logs_evidence.json");
if (!fs.existsSync(jsonSrc)) {
  console.error("missing", jsonSrc);
  process.exit(1);
}
fs.copyFileSync(jsonSrc, path.join(stage, "phase15_ai_logs_evidence.json"));

const readmeSrc = fs.existsSync(readmeRoot) ? readmeRoot : readmeFallback;
if (!fs.existsSync(readmeSrc)) {
  console.error("missing readme");
  process.exit(1);
}
fs.copyFileSync(readmeSrc, path.join(stage, "README_EVIDENCE_CAPTURE.md"));

fs.rmSync(outZip, { force: true });
const r = spawnSync("tar.exe", ["-a", "-c", "-f", outZip, "-C", parent, NAME], {
  encoding: "utf8",
});
if (r.status !== 0) {
  console.error(r.stderr, r.error);
  process.exit(r.status ?? 1);
}
console.log("Wrote", outZip);
