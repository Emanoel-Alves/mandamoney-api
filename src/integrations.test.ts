import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import test from "node:test";
import { AuthService } from "./auth.js";
import { buildApp } from "./app.js";
import { parseConfig } from "./config.js";
import { ProviderError, ReceiptImportService } from "./integrations.js";

async function startProvider(
  handler: (body: unknown) => { status: number; body: unknown },
): Promise<{ server: Server; url: string }> {
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      const result = handler(JSON.parse(body));
      response.writeHead(result.status, { "content-type": "application/json" });
      response.end(JSON.stringify(result.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Provider did not bind a TCP port.");
  return { server, url: `http://127.0.0.1:${address.port}/parse` };
}

async function stopProvider(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

test("proxies NFC-e and OCR requests to configured providers", async () => {
  const received: unknown[] = [];
  const provider = await startProvider((body) => {
    received.push(body);
    return { status: 200, body: { success: true, items: [] } };
  });
  const config = parseConfig({
    NFCE_PROVIDER_URL: provider.url,
    OCR_PROVIDER_URL: provider.url,
  });
  const service = new ReceiptImportService(config);
  try {
    assert.deepEqual(await service.readNfce("https://sefaz.example/qr"), {
      success: true,
      items: [],
    });
    assert.deepEqual(await service.readReceipt("YWJj", "image/jpeg"), {
      success: true,
      items: [],
    });
    assert.deepEqual(received, [
      { action: "readNf", qrCode: "https://sefaz.example/qr" },
      { imageBase64: "YWJj", mimeType: "image/jpeg" },
    ]);
  } finally {
    await stopProvider(provider.server);
  }
});

test("fails explicitly when integrations are not configured", async () => {
  const service = new ReceiptImportService(parseConfig({}));
  await assert.rejects(
    service.readNfce("qr-data"),
    (error: unknown) =>
      error instanceof ProviderError &&
      error.statusCode === 503 &&
      error.code === "NFCE_NOT_CONFIGURED",
  );
  await assert.rejects(
    service.readReceipt("YWJj", "image/png"),
    (error: unknown) =>
      error instanceof ProviderError &&
      error.statusCode === 503 &&
      error.code === "OCR_NOT_CONFIGURED",
  );
});

test("rejects malformed and oversized image payloads before forwarding", async () => {
  const service = new ReceiptImportService(
    parseConfig({ OCR_PROVIDER_URL: "http://127.0.0.1:8000/ocr" }),
  );
  await assert.rejects(
    service.readReceipt("not base64", "image/png"),
    (error: unknown) =>
      error instanceof ProviderError && error.code === "INVALID_IMAGE",
  );
  await assert.rejects(
    service.readReceipt("A".repeat(700_004), "image/png"),
    (error: unknown) =>
      error instanceof ProviderError && error.code === "INVALID_IMAGE",
  );
});

test("does not expose upstream failure bodies or accept insecure remote providers", async () => {
  const provider = await startProvider(() => ({
    status: 500,
    body: { privateError: "provider secret" },
  }));
  const service = new ReceiptImportService(
    parseConfig({ OCR_PROVIDER_URL: provider.url }),
  );
  try {
    await assert.rejects(
      service.readReceipt("YWJj", "image/webp"),
      (error: unknown) =>
        error instanceof ProviderError &&
        error.statusCode === 502 &&
        !error.message.includes("provider secret"),
    );
  } finally {
    await stopProvider(provider.server);
  }
  assert.throws(
    () => parseConfig({ OCR_PROVIDER_URL: "http://remote.example/ocr" }),
    /HTTPS/,
  );
});

test("requires a bearer session before forwarding import requests", async () => {
  const accessToken = "b".repeat(43);
  const tokenHash = createHash("sha256").update(accessToken).digest("hex");
  const auth = new AuthService({
    async findUserByPhone() {
      return null;
    },
    async findUserById(userId) {
      return userId === "user-1" ? { id: userId, name: "User" } : null;
    },
    async createSession() {},
    async findActiveSession(hash, now) {
      if (hash !== tokenHash) return null;
      return {
        _id: "session-1",
        userId: "user-1",
        tokenHash,
        createdAt: new Date(now.getTime() - 1_000),
        expiresAt: new Date(now.getTime() + 60_000),
        revokedAt: null,
      };
    },
    async revokeSession() {},
  });
  const app = await buildApp({
    config: parseConfig({
      NODE_ENV: "test",
      OCR_PROVIDER_URL: "https://provider.example/ocr",
    }),
    database: { async ping() {} },
    auth,
    imports: new ReceiptImportService(
      parseConfig({ OCR_PROVIDER_URL: "https://provider.example/ocr" }),
    ),
  });
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/imports/receipt/ocr",
      payload: { imageBase64: "YWJj", mimeType: "image/jpeg" },
    });
    assert.equal(response.statusCode, 401);
  } finally {
    await app.close();
  }
});
