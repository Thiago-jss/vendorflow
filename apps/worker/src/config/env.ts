import { z } from "zod";

const url = z.string().url();

export const environmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: url,
  REDIS_URL: url,
  RABBITMQ_URL: url
});

export type Environment = z.infer<typeof environmentSchema>;

export function validateEnvironment(environment: Record<string, unknown>): Environment {
  const parsed = environmentSchema.safeParse(environment);

  if (!parsed.success) {
    throw new Error(`Invalid environment configuration: ${parsed.error.issues.map((issue) => issue.path.join(".") + ": " + issue.message).join("; ")}`);
  }

  return parsed.data;
}
