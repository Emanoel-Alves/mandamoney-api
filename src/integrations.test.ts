import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { AuthService } from "./auth.js";
import { buildApp } from "./app.js";
import { parseConfig } from "./config.js";
import { ProviderError, ReceiptImportService } from "./integrations.js";

test("sends receipt image to Gemini and normalizes its JSON response", async () => {
  const requests: {
    url: string;
    headers: Headers;
    body: Record<string, unknown>;
  }[] = [];
  const service = new ReceiptImportService(
    parseConfig({
      GEMINI_API_KEY: "server-only-test-key",
      GEMINI_MODEL: "gemini-3.6-flash",
      GEMINI_FALLBACK_MODEL: "gemini-2.5-flash",
    }),
    async (input, init) => {
      requests.push({
        url: String(input),
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)),
      });
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      items: [
                        { product: " Arroz ", value: 12.5 },
                        { product: "", value: 5 },
                        { product: "Preço inválido", value: "N/A" },
                      ],
                      market: "Mercado Teste",
                      date: "04/10/2026",
                    }),
                  },
                ],
              },
            },
          ],
        }),
      );
    },
  );

  assert.deepEqual(await service.readReceipt("YWJj", "image/jpeg"), {
    success: true,
    market: "Mercado Teste",
    date: "04/10/2026",
    items: [{ product: "Arroz", value: 12.5 }],
  });
  assert.equal(
    requests[0]?.url,
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent",
  );
  assert.equal(
    requests[0]?.headers.get("x-goog-api-key"),
    "server-only-test-key",
  );
  assert.deepEqual(requests[0]?.body.generationConfig, {
    temperature: 0.1,
    responseMimeType: "application/json",
  });
  const contents = requests[0]?.body.contents;
  assert.ok(Array.isArray(contents));
  const parts = (contents[0] as Record<string, unknown>).parts;
  assert.ok(Array.isArray(parts));
  assert.match(
    (parts[0] as Record<string, unknown>).text as string,
    /extraia todos os produtos/,
  );
  assert.deepEqual(parts[1], {
    inline_data: { mime_type: "image/jpeg", data: "YWJj" },
  });
});

test("falls back to Gemini 2.5 Flash when the primary model fails", async () => {
  const requestedModels: string[] = [];
  const service = new ReceiptImportService(
    parseConfig({
      GEMINI_API_KEY: "server-only-test-key",
      GEMINI_MODEL: "gemini-3.6-flash",
      GEMINI_FALLBACK_MODEL: "gemini-2.5-flash",
    }),
    async (input) => {
      requestedModels.push(String(input));
      if (requestedModels.length === 1) {
        return new Response("unavailable", { status: 500 });
      }
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      items: [{ product: "Leite", value: 6.25 }],
                      market: "Mercado",
                      date: "04/10/2026",
                    }),
                  },
                ],
              },
            },
          ],
        }),
      );
    },
  );

  assert.deepEqual(await service.readReceipt("YWJj", "image/jpeg"), {
    success: true,
    market: "Mercado",
    date: "04/10/2026",
    items: [{ product: "Leite", value: 6.25 }],
  });
  assert.deepEqual(
    requestedModels.map((url) => new URL(url).pathname),
    [
      "/v1beta/models/gemini-3.6-flash:generateContent",
      "/v1beta/models/gemini-2.5-flash:generateContent",
    ],
  );
});

test("reports when Gemini cannot identify products", async () => {
  const service = new ReceiptImportService(
    parseConfig({ GEMINI_API_KEY: "server-only-test-key" }),
    async () =>
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [{ text: '{"items":[],"market":"","date":""}' }],
              },
            },
          ],
        }),
      ),
  );

  await assert.rejects(
    service.readReceipt("YWJj", "image/jpeg"),
    (error: unknown) =>
      error instanceof ProviderError &&
      error.statusCode === 422 &&
      error.code === "OCR_NO_ITEMS",
  );
});

test("retries Gemini rate limits and does not expose provider errors", async () => {
  const statuses: number[] = [];
  const delays: number[] = [];
  const service = new ReceiptImportService(
    parseConfig({ GEMINI_API_KEY: "server-only-test-key" }),
    async () => {
      const status = [429, 503, 500, 500][statuses.length] ?? 500;
      statuses.push(status);
      return new Response(
        JSON.stringify({ error: { message: "private provider response" } }),
        { status },
      );
    },
    async (milliseconds) => {
      delays.push(milliseconds);
    },
  );

  await assert.rejects(
    service.readReceipt("YWJj", "image/jpeg"),
    (error: unknown) =>
      error instanceof ProviderError &&
      error.statusCode === 502 &&
      !error.message.includes("private provider response"),
  );
  assert.deepEqual(statuses, [429, 503, 500, 500]);
  assert.deepEqual(delays, [1_500, 3_000]);
});

test("requires a Gemini API key for receipt OCR", async () => {
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
    parseConfig({ GEMINI_API_KEY: "server-only-test-key" }),
  );
  await assert.rejects(
    service.readReceipt("not base64", "image/png"),
    (error: unknown) =>
      error instanceof ProviderError &&
      error.statusCode === 400 &&
      error.code === "INVALID_IMAGE",
  );
  await assert.rejects(
    service.readReceipt("A".repeat(700_004), "image/png"),
    (error: unknown) =>
      error instanceof ProviderError &&
      error.statusCode === 400 &&
      error.code === "INVALID_IMAGE",
  );
});

test("does not expose Gemini failure response bodies", async () => {
  const service = new ReceiptImportService(
    parseConfig({ GEMINI_API_KEY: "server-only-test-key" }),
    async () =>
      new Response(
        JSON.stringify({ error: { message: "private provider response" } }),
        { status: 500 },
      ),
  );

  await assert.rejects(
    service.readReceipt("YWJj", "image/webp"),
    (error: unknown) =>
      error instanceof ProviderError &&
      error.statusCode === 502 &&
      !error.message.includes("private provider response"),
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
      GEMINI_API_KEY: "server-only-test-key",
    }),
    database: { async ping() {} },
    auth,
    imports: new ReceiptImportService(
      parseConfig({ GEMINI_API_KEY: "server-only-test-key" }),
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
