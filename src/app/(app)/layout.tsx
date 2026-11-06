import type { ReactNode } from "react";
import { Providers } from "@/components/providers";
import { AppShell } from "@/components/shell";

export default function AppLayout({ children }: { children: ReactNode }) {
  return <Providers><AppShell>{children}</AppShell></Providers>;
}
