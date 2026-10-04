import type { FastifyInstance } from "fastify";
import type { AuthService } from "./auth.js";
import { requireAuthentication } from "./auth.js";
import type { AppConfig } from "./config.js";

const providerTimeoutMs = 20_000;
const maxProviderResponseBytes = 1_048_576;
const maxReceiptImageBase64Length = 700_000;
const sefazCeNfceUrl =
  "http://nfce.sefaz.ce.gov.br/nfce/api/notasFiscal/qrcodev2/";
const sefazCeQrHost = "nfce.sefaz.ce.gov.br";

export class ProviderError extends Error {
  constructor(
    readonly statusCode: 400 | 502 | 503 | 504,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export class ReceiptImportService {
  constructor(
    private readonly config: AppConfig,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async readNfce(qrCode: string): Promise<unknown> {
    const payload = parseSefazCeQrCode(qrCode);
    let response: Response;
    try {
      response = await this.fetcher(sefazCeNfceUrl, {
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
        throw new ProviderError(504, "PROVIDER_TIMEOUT", "SEFAZ timed out.");
      }
      throw new ProviderError(
        502,
        "PROVIDER_UNAVAILABLE",
        "SEFAZ could not be reached.",
      );
    }

    const result = await readJsonResponse(response, "SEFAZ");
    if (typeof result.erro === "string" && result.erro.trim()) {
      throw new ProviderError(
        502,
        "NFCE_REJECTED",
        decodeHtml(result.erro).slice(0, 300),
      );
    }
    if (typeof result.xml !== "string" || !result.xml.trim()) {
      throw new ProviderError(
        502,
        "NFCE_INVALID_RESPONSE",
        "SEFAZ did not return NFC-e data.",
      );
    }

    return parseNfceHtml(result.xml);
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
      response = await this.fetcher(providerUrl, {
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

    return readJsonResponse(response, providerName);
  }
}

function parseSefazCeQrCode(qrCode: string): {
  chave_acesso: string;
  versao_qrcode: string;
  tipo_ambiente: string;
  identificador_csc: string;
  codigo_hash: string;
} {
  let url: URL;
  try {
    url = new URL(qrCode);
  } catch {
    throw new ProviderError(400, "INVALID_NFCE_QR", "QR Code URL is invalid.");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    (url.hostname !== sefazCeQrHost &&
      !url.hostname.endsWith(".sefaz.ce.gov.br")) ||
    url.port ||
    url.username ||
    url.password
  ) {
    throw new ProviderError(
      400,
      "UNSUPPORTED_NFCE_QR",
      "Only Ceará NFC-e QR codes are supported.",
    );
  }

  const parameters = url.searchParams.getAll("p");
  if (parameters.length !== 1) {
    throw new ProviderError(
      400,
      "INVALID_NFCE_QR",
      "QR Code does not contain one valid NFC-e parameter.",
    );
  }
  const encodedValues = parameters[0];
  if (!encodedValues) {
    throw new ProviderError(
      400,
      "INVALID_NFCE_QR",
      "QR Code does not contain one valid NFC-e parameter.",
    );
  }
  const values = encodedValues.split("|");
  const [accessKey, version, environment, cscIdentifier, hash] = values;
  if (
    !accessKey ||
    !version ||
    !environment ||
    !cscIdentifier ||
    !hash ||
    values.length < 5 ||
    !/^\d{44}$/.test(accessKey) ||
    !accessKey.startsWith("23") ||
    !/^\d{1,2}$/.test(version) ||
    !["1", "2"].includes(environment) ||
    !/^\d{1,10}$/.test(cscIdentifier) ||
    !/^[a-f\d]{40}$/i.test(hash)
  ) {
    throw new ProviderError(
      400,
      "INVALID_NFCE_QR",
      "QR Code format is invalid or is not a Ceará NFC-e.",
    );
  }

  return {
    chave_acesso: accessKey,
    versao_qrcode: version,
    tipo_ambiente: environment,
    identificador_csc: cscIdentifier,
    codigo_hash: hash,
  };
}

async function readJsonResponse(
  response: Response,
  providerName: string,
): Promise<Record<string, unknown>> {
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
  return parsed as Record<string, unknown>;
}

function parseNfceHtml(html: string): {
  success: true;
  market: string;
  date: string;
  items: { product: string; value: number }[];
} {
  const marketMatch = html.match(
    /class=["'][^"']*\btxtTopo\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
  );
  const dateText = decodeHtml(html.replace(/<[^>]*>/g, " "));
  const dateMatch = dateText.match(/Emiss[aã]o\s*:\s*(\d{2}\/\d{2}\/\d{4})/i);
  const itemRegex = /<tr\b[^>]*\bid=["']Item[^"']*["'][^>]*>([\s\S]*?)<\/tr>/gi;
  const items: { product: string; value: number }[] = [];
  let match: RegExpExecArray | null;

  while ((match = itemRegex.exec(html)) !== null) {
    const row = match[1];
    if (!row) continue;
    const productMatch = row.match(
      /<span\b[^>]*class=["'][^"']*\btxtTit\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i,
    );
    const valueMatch = row.match(
      /<span\b[^>]*class=["'][^"']*\bvalor\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i,
    );
    if (!productMatch?.[1] || !valueMatch?.[1]) continue;

    const product = cleanHtmlText(productMatch[1]);
    const valueText = cleanHtmlText(valueMatch[1])
      .replace(/[^\d,.-]/g, "")
      .replace(/\./g, "")
      .replace(",", ".");
    const value = Number(valueText);
    if (product && Number.isFinite(value) && value > 0) {
      items.push({ product, value });
    }
  }

  if (items.length === 0) {
    throw new ProviderError(
      502,
      "NFCE_PARSE_FAILED",
      "Could not find NFC-e products in the SEFAZ response.",
    );
  }

  return {
    success: true,
    market: marketMatch?.[1] ? cleanHtmlText(marketMatch[1]) : "NFC-e",
    date: dateMatch?.[1] ?? "",
    items,
  };
}

function cleanHtmlText(value: string): string {
  return decodeHtml(value.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtml(value: string): string {
  const namedEntities: Record<string, string> = {
    amp: "&",
    apos: "'",
    acute: "´",
    aacute: "á",
    Aacute: "Á",
    atilde: "ã",
    Atilde: "Ã",
    ccedil: "ç",
    Ccedil: "Ç",
    eacute: "é",
    Eacute: "É",
    iacute: "í",
    Iacute: "Í",
    nbsp: " ",
    oacute: "ó",
    Oacute: "Ó",
    ocirc: "ô",
    Ocirc: "Ô",
    ordm: "º",
    uacute: "ú",
    Uacute: "Ú",
    lt: "<",
    gt: ">",
    quot: '"',
  };
  return value.replace(
    /&(#x[\da-f]+|#\d+|[a-z]+);/gi,
    (entity, code: string) => {
      if (code.startsWith("#x")) {
        return String.fromCodePoint(Number.parseInt(code.slice(2), 16));
      }
      if (code.startsWith("#")) {
        return String.fromCodePoint(Number.parseInt(code.slice(1), 10));
      }
      return namedEntities[code] ?? entity;
    },
  );
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
