import { clamp } from "./math";

export function computeVwapSeries(candles) {
  const series = [];
  let pv = 0;
  let v = 0;
  for (const c of candles) {
    const tp = (c.high + c.low + c.close) / 3;
    pv += tp * c.volume;
    v += c.volume;
    series.push(v === 0 ? null : pv / v);
  }
  return series;
}

export function computeRsi(closes, period) {
  if (!Array.isArray(closes) || closes.length < period + 1) return null;

  let gains = 0;
  let losses = 0;
  for (let i = closes.length - period; i < closes.length; i += 1) {
    const prev = closes[i - 1];
    const cur = closes[i];
    const diff = cur - prev;
    if (diff > 0) gains += diff;
    else losses += -diff;
  }

  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  const rsi = 100 - 100 / (1 + rs);
  return clamp(rsi, 0, 100);
}

export function slopeLast(values, points) {
  if (!Array.isArray(values) || values.length < points) return null;
  const slice = values.slice(values.length - points);
  const first = slice[0];
  const last = slice[slice.length - 1];
  return (last - first) / (points - 1);
}

function ema(values, period) {
  if (!Array.isArray(values) || values.length < period) return null;
  const k = 2 / (period + 1);
  let prev = values[0];
  for (let i = 1; i < values.length; i += 1) {
    prev = values[i] * k + prev * (1 - k);
  }
  return prev;
}

export function computeMacd(closes, fast, slow, signal) {
  if (!Array.isArray(closes) || closes.length < slow + signal) return null;

  const fastEma = ema(closes, fast);
  const slowEma = ema(closes, slow);
  if (fastEma === null || slowEma === null) return null;

  const macdLine = fastEma - slowEma;

  const macdSeries = [];
  for (let i = 0; i < closes.length; i += 1) {
    const sub = closes.slice(0, i + 1);
    const f = ema(sub, fast);
    const s = ema(sub, slow);
    if (f === null || s === null) continue;
    macdSeries.push(f - s);
  }

  const signalLine = ema(macdSeries, signal);
  if (signalLine === null) return null;

  const hist = macdLine - signalLine;

  const prevHist = macdSeries.length >= signal + 1
    ? (macdSeries[macdSeries.length - 2] - ema(macdSeries.slice(0, macdSeries.length - 1), signal))
    : null;

  return {
    macd: macdLine,
    signal: signalLine,
    hist,
    histDelta: prevHist === null ? null : hist - prevHist
  };
}

export function computeHeikenAshi(candles) {
  if (!Array.isArray(candles) || candles.length === 0) return [];

  const ha = [];
  for (let i = 0; i < candles.length; i += 1) {
    const c = candles[i];
    const haClose = (c.open + c.high + c.low + c.close) / 4;

    const prev = ha[i - 1];
    const haOpen = prev ? (prev.open + prev.close) / 2 : (c.open + c.close) / 2;

    const haHigh = Math.max(c.high, haOpen, haClose);
    const haLow = Math.min(c.low, haOpen, haClose);

    ha.push({
      open: haOpen,
      high: haHigh,
      low: haLow,
      close: haClose,
      isGreen: haClose >= haOpen
    });
  }
  return ha;
}

export function countConsecutive(haCandles) {
  if (!Array.isArray(haCandles) || haCandles.length === 0) return { color: null, count: 0 };

  const last = haCandles[haCandles.length - 1];
  const target = last.isGreen ? "green" : "red";

  let count = 0;
  for (let i = haCandles.length - 1; i >= 0; i -= 1) {
    const c = haCandles[i];
    const color = c.isGreen ? "green" : "red";
    if (color !== target) break;
    count += 1;
  }

  return { color: target, count };
}

export function scoreDirection(inputs) {
  const {
    price,
    vwap,
    vwapSlope,
    rsi,
    rsiSlope,
    macd,
    heikenColor,
    heikenCount,
    failedVwapReclaim
  } = inputs;

  let up = 1;
  let down = 1;

  if (price !== null && vwap !== null) {
    if (price > vwap) up += 2;
    if (price < vwap) down += 2;
  }

  if (vwapSlope !== null) {
    if (vwapSlope > 0) up += 2;
    if (vwapSlope < 0) down += 2;
  }

  if (rsi !== null && rsiSlope !== null) {
    if (rsi > 55 && rsiSlope > 0) up += 2;
    if (rsi < 45 && rsiSlope < 0) down += 2;
  }

  if (macd?.hist !== null && macd?.histDelta !== null) {
    const expandingGreen = macd.hist > 0 && macd.histDelta > 0;
    const expandingRed = macd.hist < 0 && macd.histDelta < 0;
    if (expandingGreen) up += 2;
    if (expandingRed) down += 2;

    if (macd.macd > 0) up += 1;
    if (macd.macd < 0) down += 1;
  }

  if (heikenColor) {
    if (heikenColor === "green" && heikenCount >= 2) up += 1;
    if (heikenColor === "red" && heikenCount >= 2) down += 1;
  }

  if (failedVwapReclaim === true) down += 3;

  const rawUp = up / (up + down);
  return { upScore: up, downScore: down, rawUp };
}

export function applyTimeAwareness(rawUp, remainingMinutes, windowMinutes) {
  const timeDecay = clamp(remainingMinutes / windowMinutes, 0, 1);
  const adjustedUp = clamp(0.5 + (rawUp - 0.5) * timeDecay, 0, 1);
  return { timeDecay, adjustedUp, adjustedDown: 1 - adjustedUp };
}

export function detectRegime({ price, vwap, vwapSlope, vwapCrossCount, volumeRecent, volumeAvg }) {
  if (price === null || vwap === null || vwapSlope === null) return { regime: "CHOP", reason: "missing_inputs" };

  const above = price > vwap;
  const lowVolume = volumeRecent !== null && volumeAvg !== null ? volumeRecent < 0.6 * volumeAvg : false;

  if (lowVolume && Math.abs((price - vwap) / vwap) < 0.001) {
    return { regime: "CHOP", reason: "low_volume_flat" };
  }

  if (above && vwapSlope > 0) return { regime: "TREND_UP", reason: "price_above_vwap_slope_up" };
  if (!above && vwapSlope < 0) return { regime: "TREND_DOWN", reason: "price_below_vwap_slope_down" };

  if (vwapCrossCount !== null && vwapCrossCount >= 3) {
    return { regime: "RANGE", reason: "frequent_vwap_cross" };
  }

  return { regime: "RANGE", reason: "default" };
}

export function computeEdge({ modelUp, modelDown, marketYes, marketNo }) {
  if (marketYes === null || marketNo === null) {
    return { marketUp: null, marketDown: null, edgeUp: null, edgeDown: null };
  }

  const sum = marketYes + marketNo;
  const marketUp = sum > 0 ? marketYes / sum : null;
  const marketDown = sum > 0 ? marketNo / sum : null;

  const edgeUp = marketUp === null ? null : modelUp - marketUp;
  const edgeDown = marketDown === null ? null : modelDown - marketDown;

  return {
    marketUp: marketUp === null ? null : clamp(marketUp, 0, 1),
    marketDown: marketDown === null ? null : clamp(marketDown, 0, 1),
    edgeUp,
    edgeDown
  };
}

export function decide({ remainingMinutes, edgeUp, edgeDown, modelUp = null, modelDown = null }) {
  const phase = remainingMinutes > 10 ? "EARLY" : remainingMinutes > 5 ? "MID" : "LATE";
  const threshold = phase === "EARLY" ? 0.05 : phase === "MID" ? 0.1 : 0.2;
  const minProb = phase === "EARLY" ? 0.55 : phase === "MID" ? 0.6 : 0.65;

  if (edgeUp === null || edgeDown === null) {
    return { action: "NO_TRADE", side: null, phase, reason: "missing_market_data" };
  }

  const bestSide = edgeUp > edgeDown ? "UP" : "DOWN";
  const bestEdge = bestSide === "UP" ? edgeUp : edgeDown;
  const bestModel = bestSide === "UP" ? modelUp : modelDown;

  if (bestEdge < threshold) return { action: "NO_TRADE", side: null, phase, reason: `edge_below_${threshold}` };
  if (bestModel !== null && bestModel < minProb) return { action: "NO_TRADE", side: null, phase, reason: `prob_below_${minProb}` };

  const strength = bestEdge >= 0.2 ? "STRONG" : bestEdge >= 0.1 ? "GOOD" : "OPTIONAL";
  return { action: "ENTER", side: bestSide, phase, strength, edge: bestEdge };
}
