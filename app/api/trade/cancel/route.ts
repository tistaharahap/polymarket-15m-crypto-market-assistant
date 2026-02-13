import { cancelOrder } from "../../../../src/trading/index";
import {
  ensureTradingEnabled,
  jsonError,
  jsonResponse,
  parseString
} from "../utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req) {
  const guard = ensureTradingEnabled();
  if (guard) return guard;

  let body;
  try {
    body = await req.json();
  } catch {
    return jsonError("Invalid JSON body");
  }

  const orderId = parseString(body?.orderId, "orderId");
  if (orderId.error) return jsonError(orderId.error);

  const ok = await cancelOrder(orderId.value);
  if (!ok) return jsonError("Failed to cancel order", 502);
  return jsonResponse({ ok: true });
}
