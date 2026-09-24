import type { Metadata } from "next";
import { Diagnostics } from "./Diagnostics";

export const metadata: Metadata = { title: "Diagnostics — RBC Guardian concept" };

export default function SettingsPage() {
  return <Diagnostics />;
}
