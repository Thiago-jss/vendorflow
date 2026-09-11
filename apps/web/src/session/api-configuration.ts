/**
 * The single place the browser learns where the API lives.
 *
 * It is a function rather than a module-level constant on purpose: `next build` evaluates
 * client modules while prerendering, and a constant that throws would turn a missing
 * development variable into a failed build instead of a clear message in the one place that
 * needs the value.
 */
const API_BASE_URL_VARIABLE = "NEXT_PUBLIC_API_URL";

export class ApiConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApiConfigurationError";
  }
}

export function readApiBaseUrl(rawValue: string | undefined): string {
  if (rawValue === undefined || rawValue.trim().length === 0) {
    throw new ApiConfigurationError(
      `${API_BASE_URL_VARIABLE} is not set. Point it at the VendorFlow API origin, such as http://localhost:3001.`
    );
  }

  let parsed: URL;

  try {
    parsed = new URL(rawValue);
  } catch {
    throw new ApiConfigurationError(
      `${API_BASE_URL_VARIABLE} is not a valid absolute URL.`
    );
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ApiConfigurationError(
      `${API_BASE_URL_VARIABLE} must use http or https.`
    );
  }

  // Stored without a trailing slash so every caller can write "/auth/login" and get one
  // separator rather than two.
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
}

export function apiBaseUrl(): string {
  return readApiBaseUrl(process.env.NEXT_PUBLIC_API_URL);
}
