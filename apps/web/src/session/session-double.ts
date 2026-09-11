import { vi } from "vitest";
import type { BrowserSession } from "./browser-session";
import type { CurrentOrganizationContext } from "./current-context";

/**
 * A stand-in for the browser session, used by component specs.
 *
 * It lives beside the real session rather than in a test folder because it has to track the
 * same interface: a component spec that drifts from the transport contract proves nothing.
 * Nothing in the application imports it.
 */
export function createSessionDouble(
  overrides: Partial<BrowserSession> = {}
): BrowserSession {
  return {
    login: vi.fn(async () => {}),
    bootstrap: vi.fn(async () => true),
    logout: vi.fn(async () => {}),
    request: vi.fn(async () => ({}) as never),
    hasAccessToken: () => true,
    onSessionEnded: () => () => {},
    ...overrides
  };
}

export const currentContextFixture: CurrentOrganizationContext = {
  organization: { id: "organization-1", name: "Indústrias Acme" },
  membership: {
    userId: "user-1",
    branch: { id: "branch-1", name: "Matriz" },
    department: { id: "department-1", name: "Operações" },
    roles: ["EMPLOYEE"]
  }
};
