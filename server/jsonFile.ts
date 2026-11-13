import fs from "node:fs";

// Write one collection record at a time so saving a large application store
// does not allocate another full-store JSON string and UTF-8 buffer together.
export function writeJsonFileAtomic(file: string, data: Record<string, unknown>) {
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporary, "wx");
    const write = (text: string) => { fs.writeFileSync(descriptor!, text); };
    write("{");
    let separator = "";
    for (const [key, value] of Object.entries(data)) {
      if (value === undefined) continue;
      write(separator);
      write(JSON.stringify(key));
      write(":");
      if (Array.isArray(value)) {
        write("[");
        let itemSeparator = "";
        for (const item of value) {
          write(itemSeparator);
          write(JSON.stringify(item) ?? "null");
          itemSeparator = ",";
        }
        write("]");
      } else {
        write(JSON.stringify(value));
      }
      separator = ",";
    }
    write("}");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, file);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(temporary, { force: true });
  }
}
