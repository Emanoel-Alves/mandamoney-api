import assert from "node:assert/strict";
import test from "node:test";
import { parseConfig, requireMongoUri } from "./config.js";

test("uses safe local defaults and explicit development origin", () => {
  const config = parseConfig({ NODE_ENV: "test" });
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.port, 3000);
  assert.equal(config.trustProxy, false);
  assert.deepEqual(config.corsOrigins, [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
  ]);
});

test("rejects wildcard CORS origins", () => {
  assert.throws(() => parseConfig({ CORS_ORIGINS: "*" }), /wildcard/);
});

test("rejects CORS paths instead of silently broadening the origin", () => {
  assert.throws(
    () => parseConfig({ CORS_ORIGINS: "https://example.com/path" }),
    /without a path/,
  );
});

test("rejects non-boolean reverse proxy configuration", () => {
  assert.throws(() => parseConfig({ TRUST_PROXY: "sometimes" }));
});

test("accepts an unset legacy login pepper and rejects short secrets", () => {
  assert.equal(
    parseConfig({ LEGACY_AUTH_PEPPER: "" }).legacyAuthPepper,
    undefined,
  );
  assert.throws(() => parseConfig({ LEGACY_AUTH_PEPPER: "too-short" }));
});

test("configures Gemini credentials and restricts the model name", () => {
  const config = parseConfig({
    GEMINI_API_KEY: "gemini-test-key",
    GEMINI_MODEL: "gemini-3.6-flash",
    GEMINI_FALLBACK_MODEL: "gemini-2.5-flash",
  });
  assert.equal(config.geminiApiKey, "gemini-test-key");
  assert.equal(config.geminiModel, "gemini-3.6-flash");
  assert.equal(config.geminiFallbackModel, "gemini-2.5-flash");
  assert.equal(parseConfig({ GEMINI_API_KEY: "  " }).geminiApiKey, undefined);
  assert.throws(() => parseConfig({ GEMINI_MODEL: "../other-model" }));
});

test("accepts only HTTPS remote NFC-e providers", () => {
  assert.throws(
    () =>
      parseConfig({
        NFCE_PROVIDER_URL: "https://user:password@example.com/exec",
      }),
    /embedded credentials/,
  );
});

test("requires a MongoDB URI to start the server", () => {
  const config = parseConfig({});
  assert.throws(() => requireMongoUri(config), /MONGODB_URI is required/);
});
