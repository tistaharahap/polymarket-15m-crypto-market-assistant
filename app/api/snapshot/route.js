import { computeSnapshot } from "../../../src/web/snapshot.js";

export const dynamic = "force-dynamic";

export async function GET(req) {
  try {
    const url = new URL(req.url);
    const asset = url.searchParams.get("asset") ?? "btc";
    const out = await computeSnapshot({ asset });
    return Response.json(out, {
      headers: {
        "Cache-Control": "no-store, max-age=0"
      }
    });
  } catch (e) {
    return Response.json(
      { error: e?.message ?? String(e) },
      { status: 500, headers: { "Cache-Control": "no-store, max-age=0" } }
    );
  }
}
