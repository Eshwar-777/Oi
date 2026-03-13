import fs from "node:fs";
import path from "node:path";

export function writeTextAtomic(targetPath: string, text: string): void {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, text, "utf8");
}
