// Shared by the browser, HTTP service and isolated archive worker.
export function isInvoiceAuxiliaryPath(filename) {
  const normalized = filename.replace(/\\/g, "/");
  if (normalized.endsWith("/")) return true;

  return normalized.split("/").some(part => {
    const name = part.toLowerCase();
    return name === ".ds_store" || name === "__macosx" ||
      name === "thumbs.db" || name === "ehthumbs.db" ||
      name === "desktop.ini" || part.startsWith("._");
  });
}
