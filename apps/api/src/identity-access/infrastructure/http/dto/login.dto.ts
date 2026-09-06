import { IsEmail, IsString, MaxLength, MinLength } from "class-validator";

/**
 * The global `ValidationPipe` runs with `whitelist` and `forbidNonWhitelisted`, so a body
 * carrying anything beyond these two fields is rejected rather than quietly trimmed
 * (SEC-004).
 */
export class LoginRequestDto {
  @IsEmail()
  @MaxLength(320)
  email!: string;

  /**
   * Bounded only to keep an unbounded body out of the hasher. Argon2's cost comes from its
   * memory and time parameters rather than input length, so this is a resource guard, not a
   * password policy.
   */
  @IsString()
  @MinLength(1)
  @MaxLength(1024)
  password!: string;
}
