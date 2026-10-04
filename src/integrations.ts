import type { FastifyInstance } from "fastify";
import type { AuthService } from "./auth.js";
import { requireAuthentication } from "./auth.js";
import type { AppConfig } from "./config.js";

const providerTimeoutMs = 20_000;
const maxProviderResponseBytes = 1_048_576;
const maxReceiptImageBase64Length = 700_000;

export class ProviderError extends Error {
  constructor(
    readonly statusCode: 502 | 503 | 504,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export class ReceiptImportService {
  constructor(private readonly config: AppConfig) {}

  async readNfce(qrCode: string): Promise<unknown> {
    if (!this.config.nfceProviderUrl) {
      throw new ProviderError(
        503,
        "NFCE_NOT_CONFIGURED",
        "NFC-e import is not configured on the API.",
      );
    }
    return this.forwardJson(
      this.config.nfceProviderUrl,
      { action: "readNf", qrCode },
      "NFC-e",
    );
  }

  async readReceipt(imageBase64: string, mimeType: string): Promise<unknown> {
    if (!this.config.ocrProviderUrl) {
      throw new ProviderError(
        503,
        "OCR_NOT_CONFIGURED",
        "Receipt OCR is not configured on the API.",
      );
    }
    if (
      imageBase64.length > maxReceiptImageBase64Length ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        imageBase64,
      )
    ) {
      throw new ProviderError(
        502,
        "INVALID_IMAGE",
        "Receipt image encoding is invalid or exceeds the supported size.",
      );
    }
    return this.forwardJson(
      this.config.ocrProviderUrl,
      { imageBase64, mimeType },
      "receipt OCR",
    );
  }

  private async forwardJson(
    providerUrl: string,
    payload: object,
    providerName: string,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(providerUrl, {
        method: "POST",
        redirect: "error",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(providerTimeoutMs),
      });
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") {
        throw new ProviderError(
          504,
          "PROVIDER_TIMEOUT",
          `${providerName} provider timed out.`,
        );
      }
      throw new ProviderError(
        502,
        "PROVIDER_UNAVAILABLE",
        `${providerName} provider could not be reached.`,
      );
    }

    const declaredLength = Number(response.headers.get("content-length") ?? 0);
    if (declaredLength > maxProviderResponseBytes) {
      await response.body?.cancel();
      throw new ProviderError(
        502,
        "PROVIDER_RESPONSE_TOO_LARGE",
        `${providerName} provider returned an oversized response.`,
      );
    }
    const body = await readLimitedBody(response, providerName);
    if (!response.ok) {
      throw new ProviderError(
        502,
        "PROVIDER_REJECTED_REQUEST",
        `${providerName} provider returned an error.`,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(body));
    } catch {
      throw new ProviderError(
        502,
        "PROVIDER_INVALID_RESPONSE",
        `${providerName} provider returned invalid JSON.`,
      );
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new ProviderError(
        502,
        "PROVIDER_INVALID_RESPONSE",
        `${providerName} provider returned an unexpected response.`,
      );
    }
    return parsed;
  }
}

async function readLimitedBody(
  response: Response,
  providerName: string,
): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxProviderResponseBytes) {
        await reader.cancel();
        throw new ProviderError(
          502,
          "PROVIDER_RESPONSE_TOO_LARGE",
          `${providerName} provider returned an oversized response.`,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export function registerImportRoutes(
  app: FastifyInstance,
  imports: ReceiptImportService,
  auth: AuthService,
): void {
  app.post<{ Body: { qrCode: string } }>(
    "/api/v1/imports/nfce/qr",
    {
      preHandler: requireAuthentication(auth),
      schema: {
        body: {
          type: "object",
          required: ["qrCode"],
          additionalProperties: false,
          properties: {
            qrCode: { type: "string", minLength: 1, maxLength: 4096 },
          },
        },
      },
    },
    async (request) => imports.readNfce(request.body.qrCode),
  );

  app.post<{ Body: { imageBase64: string; mimeType: string } }>(
    "/api/v1/imports/receipt/ocr",
    {
      bodyLimit: 750_000,
      preHandler: requireAuthentication(auth),
      schema: {
        body: {
          type: "object",
          required: ["imageBase64", "mimeType"],
          additionalProperties: false,
          properties: {
            imageBase64: {
              type: "string",
              minLength: 4,
              maxLength: maxReceiptImageBase64Length,
            },
            mimeType: {
              type: "string",
              enum: ["image/jpeg", "image/png", "image/webp"],
            },
          },
        },
      },
    },
    async (request) =>
      imports.readReceipt(request.body.imageBase64, request.body.mimeType),
  );
}
