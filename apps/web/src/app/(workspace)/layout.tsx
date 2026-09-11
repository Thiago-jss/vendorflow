"use client";

import { useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import { useSession } from "@/session/session-context";
import { AppShell } from "@/shell/app-shell";
import { LoadingRegion } from "@/ui/feedback";

/**
 * The authenticated area.
 *
 * Sending an unauthenticated visitor to the sign-in page is a courtesy, not a control: the
 * data behind these routes is protected by the API, which refuses a request without a usable
 * access token no matter which URL the browser is showing.
 */
export default function WorkspaceLayout({
  children
}: Readonly<{ children: ReactNode }>) {
  const { status } = useSession();
  const router = useRouter();

  useEffect(() => {
    if (status === "anonymous") {
      router.replace("/login");
    }
  }, [router, status]);

  if (status !== "authenticated") {
    return (
      <main className="centered">
        <LoadingRegion label="Carregando sua sessão..." />
      </main>
    );
  }

  return <AppShell>{children}</AppShell>;
}
