import { z } from "zod";

const url = z.string().url();

export const environmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  CORS_ORIGINS: z
    .string()
    .min(1, "CORS_ORIGINS must contain at least one allowed origin")
    .transform((value) => value.split(",").map((origin) => origin.trim()).filter(Boolean))
    .refine((origins) => origins.length > 0 && origins.every((origin) => url.safeParse(origin).success), {
      message: "CORS_ORIGINS must be a comma-separated list of valid URLs"
    }),
  DATABASE_URL: url
});

export type Environment = z.infer<typeof environmentSchema>;

export function validateEnvironment(environment: Record<string, unknown>): Environment {
  const parsed = environmentSchema.safeParse(environment);

  if (!parsed.success) {
    throw new Error(`Invalid environment configuration: ${parsed.error.issues.map((issue) => issue.path.join(".") + ": " + issue.message).join("; ")}`);
  }

  return parsed.data;
}
