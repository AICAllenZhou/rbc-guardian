import type { Metadata } from "next";
import { CommandCenter } from "./CommandCenter";

export const metadata: Metadata = { title: "Command Center — RBC Guardian concept" };

export default async function CasePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const safe = /^GUARD-\d{4}$/.test(id) ? id : "GUARD-4821";
  return <CommandCenter caseId={safe} />;
}
