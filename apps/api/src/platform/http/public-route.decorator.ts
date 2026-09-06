import { SetMetadata, type CustomDecorator } from "@nestjs/common";

export const IS_PUBLIC_ROUTE = "vendorflow:is-public-route";

/**
 * Marks a route as reachable without an access token.
 *
 * Authentication is default-deny: a global guard protects every route, and only a handler
 * carrying this marker is exempt. Adding a route therefore requires an explicit decision to
 * expose it, instead of an easily forgotten decision to protect it.
 */
export function Public(): CustomDecorator<string> {
  return SetMetadata(IS_PUBLIC_ROUTE, true);
}
