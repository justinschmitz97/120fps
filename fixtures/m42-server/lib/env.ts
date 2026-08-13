import fs from "node:fs";

export function readFlag(): boolean {
  return fs.existsSync(".flag");
}
