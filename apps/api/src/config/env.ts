import { z } from "zod";

const url = z.string().url();

/**
 * HS256 keys shorter than the hash output add no security and are a common misconfiguration.
 * Measured in bytes, not characters, so a short multi-byte string cannot pass as 32 bytes.
 */
const MINIMUM_JWT_SECRET_BYTES = 32;

const seconds = (fallback: number) => z.coerce.number().int().positive().default(fallback);

export const environmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  CORS_ORIGINS: z
    .string()
    .min(1, "CORS_ORIGINS must contain at least one allowed origin")
    .transform((value) => value.split(",").map((origin) => origin.trim()).filter(Boolean))
    .refine((origins) => origins.length > 0 && origins.every((origin) => url.safeParse(origin).success), {
      message: "CORS_ORIGINS must be a comma-separated list of valid URLs"
    })
    // Canonicalized so CORS and the auth Origin allowlist compare identical strings.
    .transform((origins) => origins.map((origin) => new URL(origin).origin)),
  DATABASE_URL: url,

  // Access-token signing material. No default: an application that boots with a fallback
  // signing key silently issues forgeable tokens.
  AUTH_JWT_SECRET: z
    .string({ required_error: "AUTH_JWT_SECRET is required" })
    .refine((secret) => Buffer.byteLength(secret, "utf8") >= MINIMUM_JWT_SECRET_BYTES, {
      message: `AUTH_JWT_SECRET must provide at least ${MINIMUM_JWT_SECRET_BYTES} bytes of key material`
    }),
  AUTH_JWT_ISSUER: z.string().min(1, "AUTH_JWT_ISSUER is required"),
  AUTH_JWT_AUDIENCE: z.string().min(1, "AUTH_JWT_AUDIENCE is required"),

  // 15 minutes. Short enough that a leaked access token expires quickly, long enough that
  // refresh traffic stays modest.
  AUTH_ACCESS_TOKEN_TTL_SECONDS: seconds(900),
  // 30 days, absolute. Rotation never extends it.
  AUTH_REFRESH_TOKEN_TTL_SECONDS: seconds(2_592_000),

  // Source-address limit applied to every auth POST route.
  AUTH_IP_RATE_LIMIT: z.coerce.number().int().positive().default(10),
  AUTH_IP_RATE_LIMIT_WINDOW_SECONDS: seconds(60),
  // Per-account failed-login limit, keyed by a digest of the normalized email.
  AUTH_ACCOUNT_MAX_FAILED_ATTEMPTS: z.coerce.number().int().positive().default(5),
  AUTH_ACCOUNT_LOCKOUT_WINDOW_SECONDS: seconds(900),

  // SEC-006. The Manager approval queue and decision routes, source-address dimension.
  APPROVAL_IP_RATE_LIMIT: z.coerce.number().int().positive().default(60),
  APPROVAL_IP_RATE_LIMIT_WINDOW_SECONDS: seconds(60),
  // Same two routes, authenticated-principal dimension. Lower than the address limit: one
  // manager's own budget is smaller than what their whole office may share an address for.
  APPROVAL_PRINCIPAL_RATE_LIMIT: z.coerce.number().int().positive().default(30),
  APPROVAL_PRINCIPAL_RATE_LIMIT_WINDOW_SECONDS: seconds(60)
});

export type Environment = z.infer<typeof environmentSchema>;

export function validateEnvironment(environment: Record<string, unknown>): Environment {
  const parsed = environmentSchema.safeParse(environment);

  if (!parsed.success) {
    throw new Error(`Invalid environment configuration: ${parsed.error.issues.map((issue) => issue.path.join(".") + ": " + issue.message).join("; ")}`);
  }

  return parsed.data;
}
