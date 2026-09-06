export const AUTHENTICATION_OPTIONS = Symbol("AUTHENTICATION_OPTIONS");

export interface AuthenticationOptions {
  /** Absolute refresh-session lifetime. Rotation inherits it and never extends it. */
  readonly refreshTokenTtlSeconds: number;
}
