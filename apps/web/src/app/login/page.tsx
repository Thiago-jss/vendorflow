"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { LoginForm } from "@/session/login-form";
import { useSession } from "@/session/session-context";
import { LoadingRegion } from "@/ui/feedback";

export default function LoginPage() {
  const { status } = useSession();
  const router = useRouter();

  useEffect(() => {
    if (status === "authenticated") {
      router.replace("/requests");
    }
  }, [router, status]);

  if (status !== "anonymous") {
    return (
      <main className="centered">
        <LoadingRegion label="Verificando sessão..." />
      </main>
    );
  }

  return (
    <main className="centered">
      <LoginForm />
    </main>
  );
}
