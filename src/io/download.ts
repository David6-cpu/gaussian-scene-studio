const pending = new Set<string>();
export function releaseDownloads() {
  for (const url of pending) URL.revokeObjectURL(url);
  pending.clear();
}
if (typeof window !== "undefined")
  window.addEventListener("beforeunload", releaseDownloads);
export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  pending.add(url);
  const cleanup = () => {
    if (pending.delete(url)) URL.revokeObjectURL(url);
  };
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(cleanup, 5000);
  } catch (e) {
    cleanup();
    throw e;
  }
}
