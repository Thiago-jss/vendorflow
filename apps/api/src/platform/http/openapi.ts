import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import type { INestApplication } from "@nestjs/common";
import type { OpenAPIObject } from "@nestjs/swagger";

/**
 * NFR-009: the API is documented from the same source of truth used for request validation.
 *
 * The document is built by `SwaggerModule` from the controllers' routing metadata and the
 * DTO classes the `ValidationPipe` already validates against, so the contract cannot drift
 * from behaviour the way a hand-written document does. Nothing here restates a rule; the
 * rules live on the DTOs.
 */
export const OPENAPI_DOCUMENT_PATH = "docs";
export const OPENAPI_JSON_PATH = `${OPENAPI_DOCUMENT_PATH}-json`;
export const OPENAPI_BEARER_SCHEME = "accessToken";

export function buildOpenApiDocument(
  application: INestApplication,
): OpenAPIObject {
  const configuration = new DocumentBuilder()
    .setTitle("VendorFlow API")
    .setDescription(
      [
        "Every route except the authentication endpoints requires a bearer access token;",
        "authentication is default-deny, so an undocumented security requirement means the",
        "route is protected, never that it is open.",
        "",
        "Monetary amounts are integer centavos (BRL only, BR-030/BR-031) and quantities are",
        "exact decimals. Both cross this API as strings rather than JSON numbers: a JSON",
        "number is an IEEE-754 double and can represent neither 0.1 exactly nor a centavo",
        "amount above 2^53.",
      ].join(" "),
    )
    .setVersion("0.1.0")
    .addBearerAuth(
      { type: "http", scheme: "bearer", bearerFormat: "JWT" },
      OPENAPI_BEARER_SCHEME,
    )
    .addTag(
      "purchase-requests",
      "A requester's own purchase requests: drafts, lifecycle commands and paginated reads.",
    )
    .build();

  return SwaggerModule.createDocument(application, configuration);
}

/**
 * Serves the document at `/docs` and its JSON at `/docs-json`.
 *
 * Swagger's routes are registered as middleware rather than as Nest controllers, so the
 * global access-token guard does not cover them. That is deliberate and safe: the document
 * describes the contract and contains no tenant data, and every route it lists remains
 * default-deny. Restricting the documentation route itself is a deployment concern, not an
 * application one.
 */
export function configureOpenApi(application: INestApplication): OpenAPIObject {
  const document = buildOpenApiDocument(application);

  SwaggerModule.setup(OPENAPI_DOCUMENT_PATH, application, document, {
    jsonDocumentUrl: OPENAPI_JSON_PATH,
  });

  return document;
}
