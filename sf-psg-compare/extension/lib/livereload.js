// Development only: reload the page when a file under extension/ changes.
//
// Active when the page is served by tools/dev_server.py, or when this is an unpacked copy of the
// extension (no update_url in the manifest) and the dev server is running. A store-installed
// copy never polls. If the dev server is not running, one failed request and it stops.

const DEV_SERVER = "http://127.0.0.1:8765";

export async function startLiveReload() {
  const servedByDevServer = location.protocol.startsWith("http") && location.port === "8765";
  const unpacked = typeof chrome !== "undefined" && chrome.runtime?.getManifest && !("update_url" in chrome.runtime.getManifest());
  if (!servedByDevServer && !unpacked) return;
  const url = `${servedByDevServer ? "" : DEV_SERVER}/__version`;
  const version = async () => (await (await fetch(url, { cache: "no-store" })).json()).v;
  let first;
  try { first = await version(); } catch { return; } // no dev server: stay quiet
  setInterval(async () => {
    try { if ((await version()) !== first) location.reload(); } catch { /* server stopped */ }
  }, 1500);
}
