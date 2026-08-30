import type { TrustedPrincipal } from "./trusted-principal";

const trustedPrincipalSlot: unique symbol = Symbol(
  "vendorflow.trusted-principal",
);

type TrustedPrincipalCarrier = object & {
  [trustedPrincipalSlot]?: TrustedPrincipal;
};

export class MissingTrustedPrincipalError extends Error {
  constructor() {
    super("No trusted principal is bound to this request");
    this.name = "MissingTrustedPrincipalError";
  }
}

/**
 * Reserved for future authentication infrastructure after it has verified identity,
 * organization membership, and role claims. The symbol-backed slot cannot be populated
 * by a JSON body, query parameter, header, or cookie.
 */
export function bindTrustedPrincipal(
  carrier: object,
  principal: TrustedPrincipal,
): void {
  const principalCarrier = carrier as TrustedPrincipalCarrier;

  if (Object.hasOwn(principalCarrier, trustedPrincipalSlot)) {
    throw new Error("A trusted principal is already bound to this request");
  }

  const snapshot: TrustedPrincipal = Object.freeze({
    userId: principal.userId,
    organizationId: principal.organizationId,
    roles: Object.freeze([...principal.roles]),
  });

  Object.defineProperty(principalCarrier, trustedPrincipalSlot, {
    value: snapshot,
    enumerable: false,
    configurable: false,
    writable: false,
  });
}

export function readTrustedPrincipal(carrier: object): TrustedPrincipal {
  const principal = (carrier as TrustedPrincipalCarrier)[trustedPrincipalSlot];

  if (principal === undefined) {
    throw new MissingTrustedPrincipalError();
  }

  return principal;
}
