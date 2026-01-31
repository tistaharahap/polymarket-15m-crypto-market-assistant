export const TRADING_CONFIG = {
  enabled: (process.env.TRADING_ENABLED || "false").toLowerCase() === "true",

  // Required to sign + derive API keys for the CLOB client
  privateKey: process.env.POLY_PRIVATE_KEY || "",

  // Optional (defaults to signer address)
  funderAddress: process.env.POLY_FUNDER_ADDRESS || "",

  // CLOB base URL (prod default)
  clobApi: process.env.POLY_CLOB_API || "https://clob.polymarket.com",

  // If provided, forwarded into @polymarket/clob-client
  // (Leave unset unless you know you need a specific signature type)
  signatureType: process.env.POLY_SIGNATURE_TYPE ? Number(process.env.POLY_SIGNATURE_TYPE) : undefined,

  // When true, client uses server time where supported
  useServerTime: (process.env.POLY_USE_SERVER_TIME || "false").toLowerCase() === "true"
};
