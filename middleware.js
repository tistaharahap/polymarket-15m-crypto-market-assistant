// Basic HTTP Auth for all web pages + API routes.
// Set env vars:
//   BASIC_AUTH_USER
//   BASIC_AUTH_PASS
//
// If either is missing, auth is disabled.

import { NextResponse } from "next/server";

function unauthorized() {
  return new NextResponse("Authentication required", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="Crypto 15m Assistant"'
    }
  });
}

export function middleware(req) {
  const user = process.env.BASIC_AUTH_USER;
  const pass = process.env.BASIC_AUTH_PASS;

  // Disabled unless both are set
  if (!user || !pass) return NextResponse.next();

  const auth = req.headers.get("authorization") || "";
  if (!auth.toLowerCase().startsWith("basic ")) return unauthorized();

  const b64 = auth.slice(6).trim();
  let decoded = "";
  try {
    decoded = Buffer.from(b64, "base64").toString("utf8");
  } catch {
    return unauthorized();
  }

  const idx = decoded.indexOf(":");
  if (idx < 0) return unauthorized();

  const u = decoded.slice(0, idx);
  const p = decoded.slice(idx + 1);

  if (u !== user || p !== pass) return unauthorized();

  return NextResponse.next();
}

export const config = {
  matcher: [
    // Exempt the SSE endpoint from Basic Auth to avoid EventSource auth/header limitations.
    "/((?!_next/static|_next/image|favicon.ico|api/stream).*)"
  ]
};
