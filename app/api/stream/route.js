import { computeSnapshot } from "../../../src/web/snapshot.js";

export const dynamic = "force-dynamic";

function sseEncode({ event, data, id } = {}) {
  let out = "";
  if (id !== undefined && id !== null) out += `id: ${id}\n`;
  if (event) out += `event: ${event}\n`;
  // data must be split by lines
  const lines = String(data ?? "").split("\n");
  for (const line of lines) out += `data: ${line}\n`;
  out += "\n";
  return out;
}

export async function GET(req) {
  const encoder = new TextEncoder();
  let timer = null;
  let counter = 0;
  let closed = false;

  const stream = new ReadableStream({
    start(controller) {
      const url = new URL(req.url);
      const asset = url.searchParams.get("asset") ?? "btc";

      const safeEnqueue = (chunk) => {
        if (closed) return false;
        try {
          controller.enqueue(chunk);
          return true;
        } catch {
          return false;
        }
      };

      const send = async () => {
        if (closed) return;
        counter += 1;

        try {
          const snap = await computeSnapshot({ asset });
          safeEnqueue(encoder.encode(sseEncode({ event: "snapshot", id: counter, data: JSON.stringify(snap) })));
        } catch (e) {
          // If the client disconnected, the controller is closed; don't try to write.
          safeEnqueue(encoder.encode(sseEncode({ event: "error", id: counter, data: JSON.stringify({ error: e?.message ?? String(e) }) })));
        }
      };

      // initial hello + first snapshot immediately
      safeEnqueue(encoder.encode(": connected\n\n"));
      send();

      timer = setInterval(send, 1000);
    },
    cancel() {
      closed = true;
      if (timer) clearInterval(timer);
    }
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive"
    }
  });
}
