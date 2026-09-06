import type { INestApplication } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import type { Environment } from "../../src/config/env";
import { configureHttpApplication } from "../../src/platform/http/http-configuration";

export const ALLOWED_ORIGIN = "http://localhost:3000";

/**
 * Limits are raised out of the way by default so an ordinary test is not throttled; the
 * tests that exercise abuse limits lower them explicitly.
 */
const DEFAULT_ENVIRONMENT: Readonly<Record<string, string>> = {
  NODE_ENV: "test",
  CORS_ORIGINS: ALLOWED_ORIGIN,
  AUTH_JWT_SECRET: "integration-test-access-token-signing-key-0123456789",
  AUTH_JWT_ISSUER: "vendorflow-test",
  AUTH_JWT_AUDIENCE: "vendorflow-api-test",
  AUTH_ACCESS_TOKEN_TTL_SECONDS: "900",
  AUTH_REFRESH_TOKEN_TTL_SECONDS: "2592000",
  AUTH_IP_RATE_LIMIT: "10000",
  AUTH_IP_RATE_LIMIT_WINDOW_SECONDS: "60",
  AUTH_ACCOUNT_MAX_FAILED_ATTEMPTS: "10000",
  AUTH_ACCOUNT_LOCKOUT_WINDOW_SECONDS: "900",
};

export interface HttpTestResponse {
  readonly status: number;
  readonly body: unknown;
  readonly rawBody: string;
  readonly setCookies: readonly string[];
}

export interface HttpTestRequest {
  readonly origin?: string | null;
  readonly cookie?: string | null;
  readonly accessToken?: string | null;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

/**
 * Boots the real application — the same modules, guards, pipes, filter and cookie parser
 * that `main.ts` assembles — over the PostgreSQL container. Security behaviour asserted
 * against a hand-built stub would only prove the stub.
 */
export class ApiIntegrationTestHarness {
  private constructor(
    private readonly application: INestApplication,
    readonly baseUrl: string,
    private readonly restoreEnvironment: () => void,
  ) {}

  static async start(
    environmentOverrides: Readonly<Record<string, string>> = {},
  ): Promise<ApiIntegrationTestHarness> {
    const applied = { ...DEFAULT_ENVIRONMENT, ...environmentOverrides };
    const previous = new Map<string, string | undefined>();

    for (const [name, value] of Object.entries(applied)) {
      previous.set(name, process.env[name]);
      process.env[name] = value;
    }

    const restoreEnvironment = () => {
      for (const [name, value] of previous) {
        if (value === undefined) {
          delete process.env[name];
          continue;
        }

        process.env[name] = value;
      }
    };

    try {
      // Imported only after the overrides are in place: `ConfigModule.forRoot()` reads and
      // validates the environment during module evaluation, not during instantiation.
      const { AppModule } = await import("../../src/app.module");

      const moduleReference = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();

      const application = moduleReference.createNestApplication({
        logger: false,
      });
      const configService =
        application.get<ConfigService<Environment, true>>(ConfigService);

      configureHttpApplication(application, {
        CORS_ORIGINS: configService.get("CORS_ORIGINS", { infer: true }),
      });

      await application.init();
      await application.listen(0, "127.0.0.1");

      return new ApiIntegrationTestHarness(
        application,
        await application.getUrl(),
        restoreEnvironment,
      );
    } catch (error: unknown) {
      restoreEnvironment();
      throw error;
    }
  }

  async stop(): Promise<void> {
    try {
      await this.application.close();
    } finally {
      this.restoreEnvironment();
    }
  }

  async post(
    path: string,
    request: HttpTestRequest = {},
  ): Promise<HttpTestResponse> {
    return this.send("POST", path, request);
  }

  async get(
    path: string,
    request: HttpTestRequest = {},
  ): Promise<HttpTestResponse> {
    return this.send("GET", path, request);
  }

  async put(
    path: string,
    request: HttpTestRequest = {},
  ): Promise<HttpTestResponse> {
    return this.send("PUT", path, request);
  }

  async delete(
    path: string,
    request: HttpTestRequest = {},
  ): Promise<HttpTestResponse> {
    return this.send("DELETE", path, request);
  }

  private async send(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    request: HttpTestRequest,
  ): Promise<HttpTestResponse> {
    const headers: Record<string, string> = { ...request.headers };

    // `null` means "deliberately omit"; `undefined` means "use the allowed origin".
    if (request.origin !== null) {
      headers.origin = request.origin ?? ALLOWED_ORIGIN;
    }

    if (typeof request.cookie === "string") {
      headers.cookie = request.cookie;
    }

    if (typeof request.accessToken === "string") {
      headers.authorization = `Bearer ${request.accessToken}`;
    }

    if (request.body !== undefined) {
      headers["content-type"] = "application/json";
    }

    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body:
        request.body === undefined ? undefined : JSON.stringify(request.body),
      redirect: "manual",
    });

    const rawBody = await response.text();
    // Parsed only when the response says it is JSON. The documentation route serves HTML,
    // and a blanket JSON.parse would turn "this endpoint returns a page" into a syntax error
    // inside the harness rather than an assertion in the test.
    const isJson = (response.headers.get("content-type") ?? "").includes(
      "application/json",
    );

    return {
      status: response.status,
      body:
        rawBody.length === 0 || !isJson
          ? undefined
          : (JSON.parse(rawBody) as unknown),
      rawBody,
      setCookies: response.headers.getSetCookie(),
    };
  }
}

export interface ParsedCookie {
  readonly value: string;
  readonly attributes: ReadonlyMap<string, string>;
}

export function parseSetCookie(
  setCookies: readonly string[],
  name: string,
): ParsedCookie | undefined {
  const header = setCookies.find((candidate) =>
    candidate.startsWith(`${name}=`),
  );

  if (header === undefined) {
    return undefined;
  }

  const [pair, ...rest] = header.split(";");
  const attributes = new Map<string, string>();

  for (const attribute of rest) {
    const [key, ...valueParts] = attribute.trim().split("=");
    attributes.set((key ?? "").toLowerCase(), valueParts.join("="));
  }

  return {
    value: decodeURIComponent((pair ?? "").slice(name.length + 1)),
    attributes,
  };
}

/** The cookie header a browser would send back for the refresh cookie. */
export function refreshCookieHeader(token: string): string {
  return `vf_refresh=${encodeURIComponent(token)}`;
}
