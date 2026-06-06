/**
 * Thin client for the Moonraker API on localhost:7125.
 * Sequence after payment: download gcode → upload → start print.
 */

const MOONRAKER = "http://localhost:7125";

export async function downloadGcode(url: string): Promise<Buffer> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to download gcode from ${url}: ${resp.status}`);
  const ab = await resp.arrayBuffer();
  return Buffer.from(ab);
}

export async function uploadGcode(filename: string, data: Buffer): Promise<void> {
  const form = new FormData();
  form.append("file", new Blob([data], { type: "text/plain" }), filename);
  form.append("root", "gcodes");

  const resp = await fetch(`${MOONRAKER}/server/files/upload`, {
    method: "POST",
    body: form,
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Moonraker upload failed (${resp.status}): ${text}`);
  }
}

export async function startPrint(filename: string): Promise<void> {
  const resp = await fetch(`${MOONRAKER}/printer/print/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ filename }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Moonraker start failed (${resp.status}): ${text}`);
  }
}

export async function getPrintProgress(): Promise<{ progress: number; etaSeconds: number | null } | null> {
  try {
    const resp = await fetch(`${MOONRAKER}/printer/objects/query?print_stats`);
    if (!resp.ok) return null;
    const data = await resp.json() as { result?: { status?: { print_stats?: {
      print_duration: number;
      total_duration: number;
      state: string;
    } } } };
    const stats = data.result?.status?.print_stats;
    if (!stats || stats.state !== "printing") return null;
    const progress = stats.total_duration > 0
      ? stats.print_duration / stats.total_duration
      : 0;
    const remaining = progress > 0
      ? stats.print_duration * (1 - progress) / progress
      : null;
    return { progress, etaSeconds: remaining };
  } catch {
    return null;
  }
}
