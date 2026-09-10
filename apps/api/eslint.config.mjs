import config from "@vendorflow/eslint-config";

/**
 * ADR-001 rule 6: "Boundaries are enforced mechanically — module-scoped import rules in the
 * linter and in the build. A boundary maintained by discipline alone decays; a boundary that
 * fails CI does not."
 *
 * This file is that enforcement, and `apps/api/test/architecture/module-boundaries.spec.ts`
 * is what keeps it honest: it lints synthetic files at real module paths with this very
 * configuration and asserts both that each forbidden import is refused and that the permitted
 * ones are not. A rule nothing violates is indistinguishable from a rule that does not work.
 *
 * **How flat config composes, and why this file is written the way it is.** ESLint does not
 * merge `no-restricted-imports` options across configuration objects: for a given file, the
 * last matching object *replaces* the earlier ones entirely. Layering "no foreign
 * infrastructure" on top of "no database in application code" would therefore silently switch
 * the second one off. So the restrictions are composed in JavaScript and emitted as one
 * complete option object per (module, layer), and `restrict()` is the single place that
 * assembles them.
 */

/**
 * The modules, in the partition ADR-001 declares. `platform` is deliberately among them: it
 * owns cross-cutting mechanism, and it must not reach into a business module's internals
 * either.
 */
const MODULES = [
  "approval",
  "audit",
  "identity-access",
  "platform",
  "procurement",
  "purchase-order",
  "quotation",
  "supplier",
];

/**
 * ADR-002's "Data Access Rules": direct `@prisma/client` imports are restricted to
 * `packages/database`, and the API never talks to a broker (ADR-003). True of every file here.
 */
const GLOBAL_PATHS = [
  {
    name: "@prisma/client",
    message: "Use @vendorflow/database from an explicit persistence adapter.",
  },
  {
    name: "amqplib",
    message:
      "The API never talks to a broker. Record an outgoing fact through platform's outbox capability; publishing belongs to the worker (ADR-003).",
  },
];

/**
 * ADR-002, "Data Access Rules": application code may not import Prisma, a concrete persistence
 * adapter, an HTTP adapter or worker code. A use case that can reach a database client can
 * scope a query itself, and MT-005's single enforced choke point stops being one.
 *
 * `TransactionScope` is what makes this liveable: it is opaque, application code can pass it
 * along and do nothing else with it, and only `prisma-transaction-runner` — restricted below —
 * can turn it back into a client.
 */
const APPLICATION_PATHS = [
  {
    name: "@vendorflow/database",
    message:
      "Only an explicit persistence adapter under infrastructure/ may import the database package (ADR-002).",
  },
  {
    name: "@nestjs/swagger",
    message:
      "The wire contract belongs to the HTTP adapter, not to a use case (ADR-001).",
  },
];

const APPLICATION_PATTERNS = [
  {
    group: [
      "**/infrastructure/**",
      "**/persistence/prisma-*",
      "**/apps/worker/**",
    ],
    message:
      "Application code depends on contracts, never on adapters. Inject a repository interface, or pass the opaque TransactionScope (ADR-002).",
  },
];

/**
 * ADR-001 rule 2, in the direction that would otherwise be invisible: a module may consume
 * another module's *published application operations*, and never its persistence adapters, its
 * controllers, its DTOs or its guards. Those are the internals the published interface exists
 * to hide, and importing one is how a "module boundary" quietly becomes a namespace.
 */
function foreignInfrastructurePattern(owner) {
  return {
    group: MODULES.filter((module) => module !== owner).map(
      (module) => `**/${module}/infrastructure/**`,
    ),
    message:
      "A module may use another module's published application operations, never its infrastructure. Add an operation to the owning module instead (ADR-001 rule 2).",
  };
}

/**
 * The support modules a *neighbouring* module may name, and the only ones.
 *
 * Each is a shared **vocabulary** — a closed set of statuses, roles or identifier kinds that a
 * consumer must be able to speak in order to use the owner's published operations at all — and
 * each is listed here one file at a time, so admitting another is a deliberate edit rather
 * than a drift. Nothing on this list is arithmetic, a policy decision or a state transition.
 */
const PUBLISHED_SUPPORT = [
  "**/approval/application/support/approval-authorization",
  "**/approval/application/support/approval-decision",
  "**/approval/application/support/approval-policy",
  "**/approval/application/support/approval-step-state",
  "**/procurement/application/support/purchase-request-status",
  "**/supplier/application/support/tax-identifier",
];

/**
 * ADR-001 rule 2, one level finer than the rule above it.
 *
 * `application/support` is where a module keeps its own domain reasoning: its arithmetic, its
 * authorization predicates, its state machine. Everything there that is not on
 * `PUBLISHED_SUPPORT` is an internal, and a second module importing one is not consuming a
 * published operation — it is reaching past the published interface, and the two modules stop
 * being separable.
 *
 * This is the rule that keeps the exact numeric primitives where they belong. Quantities,
 * centavos and the single half-up line-total step are not procurement's private state and are
 * not quotation's either: they live in `platform/numeric`, with the calendar-day
 * representation in `platform/calendar`, because a second definition of any of them is a
 * second answer to "what is this total". A module that needs something a neighbour genuinely
 * owns adds an operation or a contract to that neighbour instead.
 *
 * `platform`'s own capabilities nest their support under `platform/<capability>/application/`,
 * which this pattern deliberately does not match: platform is the shared layer by definition.
 */
function foreignSupportPattern(owner) {
  return {
    group: [
      ...MODULES.filter((module) => module !== owner).map(
        (module) => `**/${module}/application/support/**`,
      ),
      // gitignore-style negation: listed vocabulary is re-permitted, everything else stays out.
      ...PUBLISHED_SUPPORT.map((allowed) => `!${allowed}`),
    ],
    message:
      "A module may use another module's published use cases, contracts and declared shared vocabulary, never the rest of its application/support. Exact primitives that several modules share live in platform/numeric and platform/calendar; anything else belongs to the owning module (ADR-001 rule 2).",
  };
}

/**
 * ADR-001's partition, in the one direction that matters most here.
 *
 * `procurement` owns the PurchaseRequest state machine, and `quotation` and `purchase-order`
 * drive transitions on it through published operations. That dependency runs one way on
 * purpose: the moment `procurement` reaches back into either, the two modules become one, and
 * the only way to express the cycle in Nest is `forwardRef` — which hides a wrong dependency
 * direction rather than fixing it.
 *
 * FR-026's "which quote won" and "was an order issued" are served instead by inverted ports
 * that `procurement` declares and the owning modules implement. That is why this rule can be
 * absolute and still leave the request read complete.
 */
const PROCUREMENT_PATTERN = {
  group: ["**/quotation/**", "**/purchase-order/**"],
  message:
    "procurement owns the PurchaseRequest state machine and must not depend on quotation or purchase-order. Those modules call procurement's published operations; facts they own reach a request read through the inverted ports in application/contracts/purchase-request-supplements.ts (ADR-001 rule 2).",
};

function restrict(patterns = [], paths = []) {
  return {
    "no-restricted-imports": [
      "error",
      { paths: [...GLOBAL_PATHS, ...paths], patterns },
    ],
  };
}

function patternsFor(owner, layer) {
  return [
    foreignInfrastructurePattern(owner),
    foreignSupportPattern(owner),
    ...(owner === "procurement" ? [PROCUREMENT_PATTERN] : []),
    ...(layer === "application" ? APPLICATION_PATTERNS : []),
  ];
}

/**
 * Two objects per module, the more specific one last so it wins for the files it matches — and
 * complete in itself, because winning means replacing.
 *
 * The second glob of the application block covers `platform`, whose capabilities each carry
 * their own `application/` directory (`platform/outbox/application`,
 * `platform/idempotency/application`) rather than sharing one.
 */
const moduleRules = MODULES.flatMap((module) => [
  {
    files: [`src/${module}/**/*.ts`],
    rules: restrict(patternsFor(module, "any")),
  },
  {
    files: [
      `src/${module}/application/**/*.ts`,
      `src/${module}/*/application/**/*.ts`,
    ],
    rules: restrict(
      patternsFor(module, "application"),
      APPLICATION_PATHS,
    ),
  },
]);

export default [...config, { rules: restrict() }, ...moduleRules];
