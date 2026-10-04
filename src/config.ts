import "dotenv/config";
import { z } from "zod";

const environmentSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  HOST: z.string().min(1).default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  TRUST_PROXY: z.enum(["true", "false"]).default("false"),
  CORS_ORIGINS: z
    .string()
    .default("http://localhost:5173,http://127.0.0.1:5173"),
  MONGODB_URI: z.string().default(""),
  MONGODB_DATABASE: z.string().min(1).default("mandamoney"),
  LEGACY_AUTH_PEPPER: z.preprocess(
    (value) => (typeof value === "string" && !value.trim() ? undefined : value),
    z.string().min(32).optional(),
  ),
  NFCE_PROVIDER_URL: z.preprocess(
    (value) => (typeof value === "string" && !value.trim() ? undefined : value),
    z.string().url().optional(),
  ),
  GEMINI_API_KEY: z.preprocess(
    (value) => (typeof value === "string" && !value.trim() ? undefined : value),
    z.string().min(1).optional(),
  ),
  GEMINI_MODEL: z
    .string()
    .regex(/^[a-zA-Z0-9.-]+$/)
    .default("gemini-3.6-flash"),
  GEMINI_FALLBACK_MODEL: z
    .string()
    .regex(/^[a-zA-Z0-9.-]+$/)
    .default("gemini-2.5-flash"),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
});

export type AppConfig = {
  nodeEnv: "development" | "test" | "production";
  host: string;
  port: number;
  trustProxy: boolean;
  corsOrigins: string[];
  mongoUri: string;
  mongoDatabase: string;
  legacyAuthPepper: string | undefined;
  nfceProviderUrl: string | undefined;
  geminiApiKey: string | undefined;
  geminiModel: string;
  geminiFallbackModel: string;
  logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
};

export function parseConfig(
  environment: NodeJS.ProcessEnv = process.env,
): AppConfig {
  const parsed = environmentSchema.parse(environment);
  const corsOrigins = parsed.CORS_ORIGINS.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  if (corsOrigins.some((origin) => origin === "*")) {
    throw new Error(
      "CORS_ORIGINS must list explicit trusted origins; wildcard access is not allowed.",
    );
  }

  for (const origin of corsOrigins) {
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      throw new Error(`Invalid CORS origin: ${origin}`);
    }
    if (!["http:", "https:"].includes(url.protocol) || url.origin !== origin) {
      throw new Error(
        `CORS origin must be an HTTP(S) origin without a path: ${origin}`,
      );
    }
  }

  for (const providerUrl of [parsed.NFCE_PROVIDER_URL]) {
    if (!providerUrl) continue;
    const url = new URL(providerUrl);
    const isLocalHttp =
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !isLocalHttp) {
      throw new Error("Provider URLs must use HTTPS except for localhost.");
    }
    if (url.username || url.password) {
      throw new Error("Provider URLs must not include embedded credentials.");
    }
  }

  return {
    nodeEnv: parsed.NODE_ENV,
    host: parsed.HOST,
    port: parsed.PORT,
    trustProxy: parsed.TRUST_PROXY === "true",
    corsOrigins,
    mongoUri: parsed.MONGODB_URI,
    mongoDatabase: parsed.MONGODB_DATABASE,
    legacyAuthPepper: parsed.LEGACY_AUTH_PEPPER,
    nfceProviderUrl: parsed.NFCE_PROVIDER_URL,
    geminiApiKey: parsed.GEMINI_API_KEY,
    geminiModel: parsed.GEMINI_MODEL,
    geminiFallbackModel: parsed.GEMINI_FALLBACK_MODEL,
    logLevel: parsed.LOG_LEVEL,
  };
}

export function requireMongoUri(config: AppConfig): string {
  if (!config.mongoUri) {
    throw new Error("MONGODB_URI is required to start the API server.");
  }
  return config.mongoUri;
}
