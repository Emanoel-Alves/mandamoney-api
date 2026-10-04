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

test("allows HTTPS providers and localhost HTTP only", () => {
  assert.equal(
    parseConfig({ OCR_PROVIDER_URL: "http://127.0.0.1:8000/ocr" })
      .ocrProviderUrl,
    "http://127.0.0.1:8000/ocr",
  );
  assert.throws(
    () => parseConfig({ OCR_PROVIDER_URL: "http://provider.example/ocr" }),
    /HTTPS/,
  );
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
