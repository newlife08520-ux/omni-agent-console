import fs from "fs";
import path from "path";

const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".tiff", ".tif", ".svg", ".ico"];

export function isImageFile(filename: string): boolean {
  const ext = path.extname(filename).toLowerCase();
  return IMAGE_EXTENSIONS.includes(ext);
}

export async function parseFileContent(filePath: string, originalName: string): Promise<string> {
  const ext = path.extname(originalName).toLowerCase();

  switch (ext) {
    case ".txt":
    case ".csv":
    case ".md": {
      const raw = fs.readFileSync(filePath);
      let text: string;
      if (raw[0] === 0xEF && raw[1] === 0xBB && raw[2] === 0xBF) {
        text = raw.slice(3).toString("utf-8");
      } else if (raw[0] === 0xFF && raw[1] === 0xFE) {
        text = raw.slice(2).toString("utf16le");
      } else {
        text = raw.toString("utf-8");
      }
      return text;
    }

    case ".xlsx": {
      const XLSX = await import("xlsx");
      const workbook = XLSX.read(fs.readFileSync(filePath));
      const parts: string[] = [];
      for (const sheetName of workbook.SheetNames) {
        const sheet = workbook.Sheets[sheetName];
        const csv = XLSX.utils.sheet_to_csv(sheet, { blankrows: false });
        if (csv.trim()) {
          parts.push(`[工作表: ${sheetName}]\n${csv}`);
        }
      }
      return parts.join("\n\n");
    }

    case ".docx": {
      const buffer = fs.readFileSync(filePath);
      const text = await extractDocxText(buffer);
      return text;
    }

    case ".pdf": {
      const buffer = fs.readFileSync(filePath);
      const text = await extractPdfText(buffer);
      return text;
    }

    default:
      return fs.readFileSync(filePath, "utf-8");
  }
}

async function extractDocxText(buffer: Buffer): Promise<string> {
  const JSZip = (await import("jszip")).default;
  try {
    const zip = await JSZip.loadAsync(buffer);
    const docXml = await zip.file("word/document.xml")?.async("text");
    if (!docXml) return "";
    const textParts: string[] = [];
    const regex = /<w:t[^>]*>([^<]*)<\/w:t>/g;
    let match;
    let currentParagraph = "";
    const paragraphRegex = /<w:p[\s>]/g;
    const paragraphEndRegex = /<\/w:p>/g;
    const paragraphs = docXml.split(/<\/w:p>/);
    for (const para of paragraphs) {
      const texts: string[] = [];
      const tRegex = /<w:t[^>]*>([^<]*)<\/w:t>/g;
      let m;
      while ((m = tRegex.exec(para)) !== null) {
        texts.push(m[1]);
      }
      if (texts.length > 0) {
        textParts.push(texts.join(""));
      }
    }
    return textParts.join("\n");
  } catch (_e) {
    return "";
  }
}

async function extractPdfText(buffer: Buffer): Promise<string> {
  try {
    const lines: string[] = [];
    const content = buffer.toString("latin1");
    const streamRegex = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
    let match;
    while ((match = streamRegex.exec(content)) !== null) {
      const streamContent = match[1];
      const textRegex = /\(([^)]*)\)/g;
      let textMatch;
      while ((textMatch = textRegex.exec(streamContent)) !== null) {
        const text = textMatch[1].trim();
        if (text && text.length > 0) {
          lines.push(text);
        }
      }
      const tjRegex = /\[([^\]]*)\]\s*TJ/g;
      let tjMatch;
      while ((tjMatch = tjRegex.exec(streamContent)) !== null) {
        const tjContent = tjMatch[1];
        const parts: string[] = [];
        const partRegex = /\(([^)]*)\)/g;
        let pm;
        while ((pm = partRegex.exec(tjContent)) !== null) {
          parts.push(pm[1]);
        }
        if (parts.length > 0) {
          lines.push(parts.join(""));
        }
      }
    }
    const result = lines.filter(l => l.trim().length > 0).join("\n");
    if (result.trim().length > 0) return result;
    return "[PDF 無法提取文字內容 - 可能為掃描或圖片式 PDF]";
  } catch (_e) {
    return "[PDF 解析失敗]";
  }
}
