"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode
} from "react";
import { browserSession, type BrowserSession } from "./browser-session";
import type { CurrentOrganizationContext } from "./current-context";

export type SessionStatus = "loading" | "authenticated" | "anonymous";

export interface SessionValue {
  readonly status: SessionStatus;
  /** Present only while authenticated. */
  readonly context: CurrentOrganizationContext | null;
  readonly signIn: (email: string, password: string) => Promise<void>;
  readonly signOut: () => Promise<void>;
  readonly session: BrowserSession;
}

const SessionReactContext = createContext<SessionValue | null>(null);

export interface SessionProviderProps {
  readonly children: ReactNode;
  /** Injected by tests. Production always uses the one session of the document. */
  readonly session?: BrowserSession;
}

/**
 * The browser session as React state.
 *
 * A reload begins with no token: the provider bootstraps once, and only a successful refresh
 * followed by a successful current-context read makes the shell authenticated. Anything else
 * is anonymous, without the reason.
 */
export function SessionProvider({
  children,
  session = browserSession
}: SessionProviderProps) {
  const [status, setStatus] = useState<SessionStatus>("loading");
  const [context, setContext] = useState<CurrentOrganizationContext | null>(null);

  const loadContext = useCallback(async () => {
    const loaded = await session.request<CurrentOrganizationContext>({
      path: "/me/organization"
    });

    setContext(loaded);
    setStatus("authenticated");
  }, [session]);

  useEffect(() => {
    let active = true;

    const stopListening = session.onSessionEnded(() => {
      if (active) {
        setContext(null);
        setStatus("anonymous");
      }
    });

    void (async () => {
      try {
        if (!(await session.bootstrap())) {
          if (active) {
            setStatus("anonymous");
          }

          return;
        }

        await loadContext();
      } catch {
        if (active) {
          setContext(null);
          setStatus("anonymous");
        }
      }
    })();

    return () => {
      active = false;
      stopListening();
    };
  }, [loadContext, session]);

  const signIn = useCallback(
    async (email: string, password: string) => {
      await session.login({ email, password });

      try {
        await loadContext();
      } catch (error: unknown) {
        // A token without a readable current context is not a usable session. Give it back
        // rather than leave the shell half-initialized.
        await session.logout();

        throw error;
      }
    },
    [loadContext, session]
  );

  const signOut = useCallback(async () => {
    await session.logout();
  }, [session]);

  const value = useMemo<SessionValue>(
    () => ({ status, context, signIn, signOut, session }),
    [context, session, signIn, signOut, status]
  );

  return (
    <SessionReactContext.Provider value={value}>
      {children}
    </SessionReactContext.Provider>
  );
}

export function useSession(): SessionValue {
  const value = useContext(SessionReactContext);

  if (value === null) {
    throw new Error("useSession must be used inside a SessionProvider.");
  }

  return value;
}
