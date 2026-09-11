import type { Metadata } from "next";
import type { ReactNode } from "react";
import { SessionProvider } from "@/session/session-context";
import "./styles.css";

export const metadata: Metadata = {
  title: "VendorFlow",
  description: "Plataforma corporativa de compras"
};

/**
 * The document shell stays server-rendered: metadata, language and global styles have no
 * reason to ship as client code. The session provider below is a Client Component because
 * the access token it holds exists only in the memory of this document.
 */
export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="pt-BR">
      <body>
        <SessionProvider>{children}</SessionProvider>
      </body>
    </html>
  );
}
