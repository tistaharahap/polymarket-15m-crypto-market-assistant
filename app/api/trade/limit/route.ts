import { placeLimitOrder } from "../../../../src/trading/index";
import {
  ensureTradingEnabled,
  jsonError,
  jsonResponse,
  parseNumber,
  parseOrderType,
  parseSide,
  parseString,
  parseBool,
  parseTickSize
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

  const tokenId = parseString(body?.tokenId, "tokenId");
  if (tokenId.error) return jsonError(tokenId.error);

  const side = parseSide(body?.side);
  if (side.error) return jsonError(side.error);

  const price = parseNumber(body?.price, "price", { min: 0, allowZero: false });
  if (price.error) return jsonError(price.error);

  const size = parseNumber(body?.size, "size", { min: 0, allowZero: false });
  if (size.error) return jsonError(size.error);

  const orderType = parseOrderType(body?.orderType, undefined);
  if (orderType.error) return jsonError(orderType.error);

  let tickSize = null;
  if (body?.tickSize !== undefined && body?.tickSize !== null) {
    const parsed = parseTickSize(body.tickSize);
    if (parsed.error) return jsonError(parsed.error);
    tickSize = parsed.value;
  }

  let negRisk = null;
  if (body?.negRisk !== undefined && body?.negRisk !== null) {
    const parsed = parseBool(body.negRisk, "negRisk");
    if (parsed.error) return jsonError(parsed.error);
    negRisk = parsed.value;
  }

  const postOnly = body?.postOnly === true;

  const result = await placeLimitOrder({
    tokenId: tokenId.value,
    price: price.value,
    size: size.value,
    side: side.value,
    orderType: orderType.value,
    tickSize,
    negRisk,
    postOnly,
    returnError: true
  });

  if (!result) return jsonError("Order submission failed", 502);
  if (result.error) return jsonError(result.error, 502);
  return jsonResponse({ orderId: result.orderId, status: result.status });
}
