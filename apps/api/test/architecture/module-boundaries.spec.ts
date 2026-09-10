import { execFile } from "node:child_process";
import { resolve } from "node:path";

/**
 * ADR-001 rule 6: "Boundaries are enforced mechanically — module-scoped import rules in the
 * linter and in the build. A boundary maintained by discipline alone decays; a boundary that
 * fails CI does not."
 *
 * A lint rule that nothing violates is indistinguishable from a lint rule that does not work.
 * This suite makes the check non-vacuous: it runs the **real** ESLint configuration over
 * synthetic files at real module paths and asserts that each forbidden import is actually
 * refused — and, just as importantly, that the imports the architecture *permits* are not.
 *
 * The fixtures are never written to disk. `lintText` resolves configuration from the file path
 * it is given, so a path is all that is needed, and nothing here can leave a stray file in the
 * source tree.
 *
 * The linting itself happens in a child process (`lint-boundary-fixtures.mjs`) because the flat
 * config is an `.mjs` file that ESLint loads with a dynamic `import()`, which Jest's CommonJS
 * registry refuses. Every fixture goes through in one run, so the whole suite pays for ESLint's
 * start-up once.
 */
const API_ROOT = resolve(__dirname, "../..");
const LINT_SCRIPT = resolve(__dirname, "lint-boundary-fixtures.mjs");

interface BoundaryCase {
  readonly name: string;
  /** Where the offending file would live, relative to `apps/api`. */
  readonly filePath: string;
  readonly importPath: string;
}

interface FixtureResult {
  readonly filePath: string;
  readonly messages: readonly string[];
}

let messagesByCase: ReadonlyMap<string, readonly string[]>;

function caseKey(entry: BoundaryCase): string {
  return `${entry.filePath}\u0000${entry.importPath}`;
}

function fixtureCode(importPath: string): string {
  return `import { thing } from "${importPath}";\n\nexport const used = thing;\n`;
}

async function lintFixtures(
  cases: readonly BoundaryCase[],
): Promise<ReadonlyMap<string, readonly string[]>> {
  const payload = JSON.stringify(
    cases.map((entry) => ({
      filePath: resolve(API_ROOT, entry.filePath),
      code: fixtureCode(entry.importPath),
    })),
  );

  const stdout = await new Promise<string>((settle, fail) => {
    const child = execFile(
      process.execPath,
      [LINT_SCRIPT],
      { cwd: API_ROOT, maxBuffer: 8 * 1024 * 1024 },
      (error, out, errorOutput) => {
        if (error !== null) {
          fail(new Error(`${error.message}\n${errorOutput}`));
          return;
        }

        settle(out);
      },
    );

    child.stdin?.end(payload);
  });
  const results = JSON.parse(stdout) as readonly FixtureResult[];

  return new Map(
    cases.map((entry, index) => [
      caseKey(entry),
      results[index]?.messages ?? [],
    ]),
  );
}

function restrictedImportMessages(entry: BoundaryCase): readonly string[] {
  const messages = messagesByCase.get(caseKey(entry));

  if (messages === undefined) {
    throw new Error(`No lint result for ${entry.name}`);
  }

  return messages;
}

const FORBIDDEN: readonly BoundaryCase[] = [
  {
    name: "procurement importing quotation",
    filePath:
      "src/procurement/application/use-cases/boundary-fixture.ts",
    importPath:
      "../../../quotation/application/use-cases/select-supplier-quote",
  },
  {
    name: "procurement importing purchase-order",
    filePath: "src/procurement/application/use-cases/boundary-fixture.ts",
    importPath:
      "../../../purchase-order/application/use-cases/issue-purchase-order",
  },
  {
    name: "procurement importing purchase-order through its HTTP layer",
    filePath: "src/procurement/infrastructure/http/boundary-fixture.ts",
    importPath:
      "../../../purchase-order/infrastructure/http/controllers/purchase-orders.controller",
  },
  {
    name: "quotation importing procurement's application/support internals",
    filePath: "src/quotation/application/support/boundary-fixture.ts",
    importPath:
      "../../../procurement/application/support/purchase-request-money",
  },
  {
    name: "quotation reaching procurement's support layer from an HTTP adapter",
    filePath: "src/quotation/infrastructure/http/dto/boundary-fixture.ts",
    importPath:
      "../../../../procurement/application/support/purchase-request-approval",
  },
  {
    name: "purchase-order importing procurement's application/support internals",
    filePath: "src/purchase-order/application/support/boundary-fixture.ts",
    importPath:
      "../../../procurement/application/support/purchase-request-authorization",
  },
  {
    name: "quotation importing another module's persistence adapter",
    filePath: "src/quotation/application/use-cases/boundary-fixture.ts",
    importPath:
      "../../../procurement/infrastructure/persistence/prisma-purchase-request.repository",
  },
  {
    name: "purchase-order importing quotation's persistence adapter",
    filePath: "src/purchase-order/infrastructure/persistence/boundary-fixture.ts",
    importPath:
      "../../../quotation/infrastructure/persistence/prisma-supplier-quote.repository",
  },
  {
    name: "application code importing the database package",
    filePath: "src/quotation/application/use-cases/boundary-fixture.ts",
    importPath: "@vendorflow/database",
  },
  {
    name: "application code importing Prisma directly",
    filePath: "src/supplier/application/support/boundary-fixture.ts",
    importPath: "@prisma/client",
  },
  {
    name: "application code turning a TransactionScope back into a client",
    filePath: "src/quotation/application/use-cases/boundary-fixture.ts",
    importPath: "../../../platform/persistence/prisma-transaction-runner",
  },
  {
    name: "a platform capability's application layer importing the database package",
    filePath:
      "src/platform/idempotency/application/use-cases/boundary-fixture.ts",
    importPath: "@vendorflow/database",
  },
  {
    name: "application code reaching for the wire contract",
    filePath: "src/purchase-order/application/use-cases/boundary-fixture.ts",
    importPath: "@nestjs/swagger",
  },
  {
    name: "the API talking to a broker",
    filePath: "src/quotation/infrastructure/persistence/boundary-fixture.ts",
    importPath: "amqplib",
  },
];

const PERMITTED: readonly BoundaryCase[] = [
  {
    name: "quotation using procurement's published application operation",
    filePath: "src/quotation/application/use-cases/boundary-fixture.ts",
    importPath:
      "../../../procurement/application/use-cases/prove-purchase-request-quotable",
  },
  {
    name: "purchase-order using quotation's published application operation",
    filePath: "src/purchase-order/application/use-cases/boundary-fixture.ts",
    importPath:
      "../../../quotation/application/use-cases/get-selected-quote-for-ordering",
  },
  {
    name: "quotation using procurement's published contract",
    filePath: "src/quotation/application/use-cases/boundary-fixture.ts",
    importPath:
      "../../../procurement/application/contracts/purchase-request.errors",
  },
  {
    name: "quotation naming procurement's declared shared vocabulary",
    filePath: "src/quotation/application/support/boundary-fixture.ts",
    importPath:
      "../../../procurement/application/support/purchase-request-status",
  },
  {
    name: "quotation taking its exact numeric primitives from platform",
    filePath: "src/quotation/application/support/boundary-fixture.ts",
    importPath: "../../../platform/numeric/centavos",
  },
  {
    name: "procurement using its own application support",
    filePath: "src/procurement/application/use-cases/boundary-fixture.ts",
    importPath: "../support/purchase-request-money",
  },
  {
    name: "procurement declaring its own inverted port",
    filePath: "src/procurement/application/use-cases/boundary-fixture.ts",
    importPath: "../contracts/purchase-request-supplements",
  },
  {
    name: "a persistence adapter using the database package",
    filePath: "src/quotation/infrastructure/persistence/boundary-fixture.ts",
    importPath: "@vendorflow/database",
  },
  {
    name: "a persistence adapter unwrapping the transaction scope",
    filePath: "src/quotation/infrastructure/persistence/boundary-fixture.ts",
    importPath: "../../../platform/persistence/prisma-transaction-runner",
  },
  {
    name: "an HTTP adapter using the wire contract library",
    filePath: "src/purchase-order/infrastructure/http/dto/boundary-fixture.ts",
    importPath: "@nestjs/swagger",
  },
];

describe("module boundaries are enforced by the linter, not by discipline", () => {
  beforeAll(async () => {
    messagesByCase = await lintFixtures([...FORBIDDEN, ...PERMITTED]);
  }, 120_000);

  it.each(FORBIDDEN.map((entry) => [entry.name, entry] as const))(
    "refuses %s",
    (_name, entry) => {
      expect(restrictedImportMessages(entry)).not.toHaveLength(0);
    },
  );

  it.each(PERMITTED.map((entry) => [entry.name, entry] as const))(
    "still allows %s",
    (_name, entry) => {
      // The other half of a useful boundary: a rule that refuses everything would pass the
      // cases above and make the architecture unimplementable.
      expect(restrictedImportMessages(entry)).toEqual([]);
    },
  );

  it("explains itself, so the failure tells a reader what to do instead", () => {
    const [message] = restrictedImportMessages(FORBIDDEN[0] as BoundaryCase);

    expect(message).toContain("published operations");
    expect(message).toContain("purchase-request-supplements");
  });
});
