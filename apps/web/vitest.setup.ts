import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// React only accepts `act` from a test environment that declares itself one.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// React Testing Library only unmounts automatically when `globals` is enabled, which this
// package deliberately does not do: every test imports what it uses.
afterEach(() => {
  cleanup();
});
