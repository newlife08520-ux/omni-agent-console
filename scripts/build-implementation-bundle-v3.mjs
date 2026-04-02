/**
 * MULTI_BRAND_AGENT_OPS_IMPLEMENTATION_BUNDLE_V3.zip
 * - verify_logs 含 build.txt（完整 npm run build 輸出）
 * - UTF-8、tar -a、扁平複製 _architecture_phase1
 */
import { execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const BUNDLE_NAME = "MULTI_BRAND_AGENT_OPS_IMPLEMENTATION_BUNDLE";
const STAGING_PARENT = path.join(root, "_BUNDLE_V3_STAGING");
const STAGE = path.join(STAGING_PARENT, BUNDLE_NAME);
const OUT_ZIP = path.join(root, "MULTI_BRAND_AGENT_OPS_IMPLEMENTATION_BUNDLE_V3.zip");

const BUNDLE_PATHS = [
  "package.json",
  "shared/schema.ts",
  "server/db.ts",
  "server/reply-plan-builder.ts",
  "server/storage.ts",
  "server/phase1-agent-ops-verify.ts",
  "server/phase15-verify.ts",
  "server/phase15-evidence-harness.ts",
  "server/phase16-pilot-proof-harness.ts",
  "server/services/ai-reply.service.ts",
  "server/services/prompt-builder.ts",
  "server/services/intent-router.service.ts",
  "server/services/phase1-brand-config.ts",
  "server/services/phase1-trace-extras.ts",
  "server/services/phase1-types.ts",
  "server/services/tool-scenario-filter.ts",
  "scripts/build-implementation-bundle-v2.mjs",
  "scripts/build-implementation-bundle-v3.mjs",
  "scripts/zip-functional-evidence.mjs",
  "scripts/zip-pilot-evidence.mjs",
  "README_EVIDENCE_CAPTURE.md",
  "README_PILOT_EVIDENCE.md",
];

const ARCH_COPY_ONLY = "_architecture_phase1";

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

function copyFile(srcRel, destBase) {
  const src = path.join(root, srcRel);
  if (!fs.existsSync(src)) {
    console.warn("skip missing:", srcRel);
    return;
  }
  const dest = path.join(destBase, srcRel.split("/").join(path.sep));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function runCapture(cmd, outName) {
  const logDir = path.join(STAGE, "verify_logs");
  fs.mkdirSync(logDir, { recursive: true });
  const outPath = path.join(logDir, outName);
  try {
    const o = execSync(cmd, {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 48 * 1024 * 1024,
      env: { ...process.env, FORCE_COLOR: "0" },
    });
    fs.writeFileSync(outPath, o, "utf8");
  } catch (e) {
    const msg = e.stdout ? String(e.stdout) : "";
    const err = e.stderr ? String(e.stderr) : String(e);
    fs.writeFileSync(outPath, msg + "\n--- STDERR/ERROR ---\n" + err, "utf8");
    throw e;
  }
}

function copyDirFlat(srcRel, destBase) {
  const src = path.join(root, srcRel);
  const dest = path.join(destBase, srcRel.split("/").join(path.sep));
  fs.mkdirSync(dest, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    if (ent.isDirectory()) continue;
    fs.copyFileSync(path.join(src, ent.name), path.join(dest, ent.name));
  }
}

rmrf(STAGING_PARENT);
fs.mkdirSync(STAGE, { recursive: true });

for (const rel of BUNDLE_PATHS) {
  copyFile(rel, path.join(STAGE, "changed_source"));
}

copyDirFlat("_architecture_phase1", STAGE);

const rolloutDir = path.join(STAGE, "rollout_docs");
fs.mkdirSync(rolloutDir, { recursive: true });
const riskSrc = path.join(root, "_architecture_phase1", "PHASE1_RISK_AND_ROLLBACK.md");
if (fs.existsSync(riskSrc)) {
  fs.copyFileSync(riskSrc, path.join(rolloutDir, "PHASE1_RISK_AND_ROLLBACK.md"));
}

const patchesDir = path.join(STAGE, "patches");
fs.mkdirSync(patchesDir, { recursive: true });

let staged = false;
try {
  if (fs.existsSync(path.join(root, ARCH_COPY_ONLY))) {
    execSync(`git add -- "${ARCH_COPY_ONLY}/"`, { cwd: root, stdio: "pipe" });
    staged = true;
  }
  for (const rel of BUNDLE_PATHS) {
    const full = path.join(root, rel);
    if (fs.existsSync(full)) {
      execSync(`git add -- "${rel.replace(/\\/g, "/")}"`, { cwd: root, stdio: "pipe" });
      staged = true;
    }
  }
  if (staged) {
    const patch = execSync("git diff --cached --no-color", {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    fs.writeFileSync(path.join(patchesDir, "git_diff.patch"), patch, "utf8");
    const stat = execSync("git diff --cached --stat", {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
    fs.writeFileSync(path.join(patchesDir, "git_diff_stat.txt"), stat, "utf8");
  }
} finally {
  if (staged) {
    execSync("git reset HEAD", { cwd: root, stdio: "pipe" });
  }
}

const verifyLogFiles = [
  "check_server.txt",
  "build.txt",
  "verify_phase15.txt",
  "verify_phase1_ops.txt",
  "verify_phase34.txt",
];

runCapture("npm run check:server", "check_server.txt");
runCapture("npm run build", "build.txt");
runCapture("npm run verify:phase15", "verify_phase15.txt");
runCapture("npm run verify:phase1-ops", "verify_phase1_ops.txt");
runCapture("npx tsx server/phase34-verify.ts", "verify_phase34.txt");

const manifestsDir = path.join(STAGE, "manifests");
fs.mkdirSync(manifestsDir, { recursive: true });
const changedFiles = BUNDLE_PATHS.filter((r) => fs.existsSync(path.join(root, r)));
const patchLines = fs.existsSync(path.join(patchesDir, "git_diff.patch"))
  ? fs.readFileSync(path.join(patchesDir, "git_diff.patch"), "utf8").split("\n").length
  : 0;

for (const f of verifyLogFiles) {
  const p = path.join(STAGE, "verify_logs", f);
  if (!fs.existsSync(p)) {
    console.error("missing verify log:", f);
    process.exit(1);
  }
}

const manifest = {
  bundle: "MULTI_BRAND_AGENT_OPS_IMPLEMENTATION_BUNDLE_V3",
  generated_at: new Date().toISOString(),
  changed_source_files: changedFiles.length,
  patch_line_count: patchLines,
  paths: changedFiles,
  verify_logs: verifyLogFiles,
};
fs.writeFileSync(
  path.join(manifestsDir, "manifest.json"),
  JSON.stringify(manifest, null, 2),
  "utf8",
);

rmrf(OUT_ZIP);
const tar = spawnSync(
  "tar.exe",
  ["-a", "-c", "-f", OUT_ZIP, "-C", STAGING_PARENT, BUNDLE_NAME],
  { encoding: "utf8" },
);
if (tar.status !== 0) {
  console.error("tar failed", tar.status, tar.stderr, tar.error);
  process.exit(tar.status ?? 1);
}

console.log("Wrote", OUT_ZIP);
