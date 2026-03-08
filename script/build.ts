import { build as esbuild } from "esbuild";
import { build as viteBuild } from "vite";
import { rm, readFile, writeFile } from "fs/promises";
import path from "path";

// server deps to bundle to reduce openat(2) syscalls
// which helps cold start times
const allowlist = [
  "@google/generative-ai",
  "axios",
  "cors",
  "date-fns",
  "drizzle-orm",
  "drizzle-zod",
  "express",
  "express-rate-limit",
  "connect-redis",
  "express-session",
  "jsonwebtoken",
  "memorystore",
  "redis",
  "multer",
  "nanoid",
  "nodemailer",
  "openai",
  "stripe",
  "uuid",
  "ws",
  "xlsx",
  "zod",
  "zod-validation-error",
];

async function buildAll() {
  await rm("dist", { recursive: true, force: true });

  console.log("building client...");
  await viteBuild();

  console.log("building server...");
  const pkg = JSON.parse(await readFile("package.json", "utf-8"));
  const allDeps = [
    ...Object.keys(pkg.dependencies || {}),
    ...Object.keys(pkg.devDependencies || {}),
  ];
  const externals = allDeps.filter((dep) => !allowlist.includes(dep));

  await esbuild({
    entryPoints: ["server/index.ts"],
    platform: "node",
    bundle: true,
    format: "cjs",
    outfile: "dist/index.cjs",
    define: {
      "process.env.NODE_ENV": '"production"',
    },
    minify: true,
    external: externals,
    logLevel: "info",
  });

  const commit =
    process.env.RAILWAY_GIT_COMMIT_SHA ||
    process.env.VERCEL_GIT_COMMIT_SHA ||
    process.env.GIT_COMMIT ||
    process.env.COMMIT_SHA ||
    "";
  const versionPath = path.join(process.cwd(), "dist", "public", "version.json");
  await writeFile(
    versionPath,
    JSON.stringify({
      buildTime: new Date().toISOString(),
      commit: commit.slice(0, 12),
    }),
    "utf-8"
  );
  console.log("[build] version.json written:", commit || "(no commit env)");
}

buildAll().catch((err) => {
  console.error(err);
  process.exit(1);
});
