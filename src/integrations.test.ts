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

test("proxies receipt OCR requests to the configured provider", async () => {
  const received: unknown[] = [];
  const provider = await startProvider((body) => {
    received.push(body);
    return { status: 200, body: { success: true, items: [] } };
  });
  const config = parseConfig({
    OCR_PROVIDER_URL: provider.url,
  });
  const service = new ReceiptImportService(config);
  try {
    assert.deepEqual(await service.readReceipt("YWJj", "image/jpeg"), {
      success: true,
      items: [],
    });
    assert.deepEqual(received, [
      { imageBase64: "YWJj", mimeType: "image/jpeg" },
    ]);
  } finally {
    await stopProvider(provider.server);
  }
});

test("fails explicitly when OCR is not configured", async () => {
  const service = new ReceiptImportService(parseConfig({}));
  await assert.rejects(
    service.readReceipt("YWJj", "image/png"),
    (error: unknown) =>
      error instanceof ProviderError &&
      error.statusCode === 503 &&
      error.code === "OCR_NOT_CONFIGURED",
  );
});

test("looks up Ceará NFC-e directly and parses SEFAZ response data", async () => {
  const requests: { url: string; body: unknown; redirect: RequestRedirect }[] =
    [];
  const html = `
    <div class="txtTopo">MERCADO &amp; CIA</div>
    <div>Emissão: 03/10/2026</div>
    <table>
      <tr id="Item1">
        <td><span class="txtTit">Pão &amp; leite</span></td>
        <td><span class="valor">12,34</span></td>
      </tr>
      <tr id="Item2">
        <td><span class="txtTit">Arroz</span></td>
        <td><span class="valor">1.234,56</span></td>
      </tr>
    </table>`;
  const service = new ReceiptImportService(
    parseConfig({}),
    async (input, init) => {
      requests.push({
        url: String(input),
        body: JSON.parse(String(init?.body)),
        redirect: init?.redirect ?? "follow",
      });
      return new Response(JSON.stringify({ xml: html }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  );
  const qrCode =
    "https://nfce.sefaz.ce.gov.br/pages/ShowNFCe.html?p=23260903995515024180650160000264791007017339%7C2%7C1%7C1%7Cc6984da2ec797b30be392ce745ef6d77e221cab3";

  assert.deepEqual(await service.readNfce(qrCode), {
    success: true,
    market: "MERCADO & CIA",
    date: "03/10/2026",
    items: [
      { product: "Pão & leite", value: 12.34 },
      { product: "Arroz", value: 1234.56 },
    ],
  });
  assert.deepEqual(requests, [
    {
      url: "http://nfce.sefaz.ce.gov.br/nfce/api/notasFiscal/qrcodev2/",
      body: {
        chave_acesso: "23260903995515024180650160000264791007017339",
        versao_qrcode: "2",
        tipo_ambiente: "1",
        identificador_csc: "1",
        codigo_hash: "c6984da2ec797b30be392ce745ef6d77e221cab3",
      },
      redirect: "error",
    },
  ]);
});

test("accepts legacy HTTP and official Ceará SEFAZ subdomains in QR URLs", async () => {
  const service = new ReceiptImportService(
    parseConfig({}),
    async () =>
      new Response(
        JSON.stringify({
          xml: `
          <tr id="Item1">
            <span class="txtTit">Produto</span>
            <span class="valor">1,00</span>
          </tr>`,
        }),
      ),
  );
  const qrPayload =
    "p=23260903995515024180650160000264791007017339%7C2%7C1%7C1%7Cc6984da2ec797b30be392ce745ef6d77e221cab3";

  for (const url of [
    `http://nfce.sefaz.ce.gov.br/consulta?${qrPayload}`,
    `https://www.sefaz.ce.gov.br/consulta?${qrPayload}`,
  ]) {
    const result = await service.readNfce(url);
    assert.deepEqual(result, {
      success: true,
      market: "NFC-e",
      date: "",
      items: [{ product: "Produto", value: 1 }],
    });
  }
});

test("rejects unsupported or malformed NFC-e QR codes before making requests", async () => {
  let requestCount = 0;
  const service = new ReceiptImportService(parseConfig({}), async () => {
    requestCount += 1;
    return new Response("{}");
  });

  for (const qrCode of [
    "https://attacker.example/?p=23260903995515024180650160000264791007017339%7C2%7C1%7C1%7Cc6984da2ec797b30be392ce745ef6d77e221cab3",
    "https://sefaz.sp.gov.br/?p=23260903995515024180650160000264791007017339%7C2%7C1%7C1%7Cc6984da2ec797b30be392ce745ef6d77e221cab3",
    "https://nfce.sefaz.ce.gov.br/?p=35260903995515024180650160000264791007017339%7C2%7C1%7C1%7Cc6984da2ec797b30be392ce745ef6d77e221cab3",
    "not a url",
  ]) {
    await assert.rejects(
      service.readNfce(qrCode),
      (error: unknown) =>
        error instanceof ProviderError &&
        error.statusCode === 400 &&
        ["UNSUPPORTED_NFCE_QR", "INVALID_NFCE_QR"].includes(error.code),
    );
  }
  assert.equal(requestCount, 0);
});

test("reports SEFAZ errors and unexpected NFC-e payloads without leaking upstream bodies", async () => {
  for (const body of [
    { erro: "Nota &ocirc; não encontrada" },
    { html: "<html>unexpected</html>" },
    {},
  ]) {
    const service = new ReceiptImportService(
      parseConfig({}),
      async () => new Response(JSON.stringify(body), { status: 200 }),
    );
    await assert.rejects(
      service.readNfce(
        "https://nfce.sefaz.ce.gov.br/consulta?p=23260903995515024180650160000264791007017339%7C2%7C1%7C1%7Cc6984da2ec797b30be392ce745ef6d77e221cab3",
      ),
      ProviderError,
    );
  }
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
