/**
 * What a successful login or refresh produces. The transport decides where each half goes:
 * the access token is returned in the JSON body and held only in frontend memory, while the
 * refresh token is written to an HttpOnly cookie and never appears in a response body.
 */
export interface AuthenticationResult {
  readonly accessToken: string;
  readonly accessTokenExpiresAt: Date;
  readonly refreshToken: string;
  readonly refreshTokenExpiresAt: Date;
}
