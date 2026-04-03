/**
 * Knowledge index for addon: metadata + 200-500 char anonymized snippet only.
 * Run: npx tsx scripts/export-knowledge-index-addon.ts <outputDir>
 */
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

const outDir = process.argv[2] || path.join(process.cwd(), "review_runtime_addon_staging", "knowledge_index");
const dbPath = path.join(process.cwd(), "omnichannel.db");

function maskText(s: string, max = 450): string {
  let t = s.replace(/\b09\d{8}\b/g, "09*******");
  t = t.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "***@***");
  t = t.replace(/ESC[A-Z0-9]{4,}/gi, "ESC***");
  return t.length > max ? t.slice(0, max) + "…[truncated]" : t;
}

function main() {
  fs.mkdirSync(outDir, { recursive: true });
  if (!fs.existsSync(dbPath)) {
    fs.writeFileSync(path.join(outDir, "README.txt"), "No omnichannel.db — empty index.\n");
    return;
  }
  const db = new Database(dbPath, { readonly: true });
  const cols = db.prepare("PRAGMA table_info(knowledge_files)").all() as { name: string }[];
  const colNames = cols.map((c) => c.name);
  const hasBrand = colNames.includes("brand_id");
  const hasContent = colNames.includes("content");
  const hasActive = colNames.includes("is_active");

  const sel = [
    "id",
    "original_name",
    "filename",
    "size",
    "created_at",
    ...(hasBrand ? ["brand_id"] : []),
    ...(hasActive ? ["is_active"] : []),
    ...(hasContent ? ["content"] : []),
  ].join(", ");
  const rows = db.prepare(`SELECT ${sel} FROM knowledge_files ORDER BY id DESC`).all() as Record<string, unknown>[];

  const index = rows.map((r) => {
    const content = (r.content as string) || "";
    const snippet = content ? maskText(content, 420) : "";
    return {
      id: r.id,
      original_name: r.original_name,
      filename: r.filename,
      brand_id: hasBrand ? r.brand_id : null,
      size_bytes: r.size,
      content_length: content.length,
      created_at: r.created_at,
      is_active: hasActive ? r.is_active : null,
      inferred_active_guess: hasActive ? null : "column_missing_assume_active_if_present_in_prompt",
      content_snippet_masked: snippet,
    };
  });

  fs.writeFileSync(path.join(outDir, "knowledge_files_index.json"), JSON.stringify(index, null, 2), "utf8");
  db.close();
  console.log("Knowledge index rows:", index.length);
}

main();
