import type { Metadata } from "next";
import { DemoRoom } from "./DemoRoom";

export const metadata: Metadata = { title: "Control room — RBC Guardian concept" };

export default function DemoPage() {
  return <DemoRoom />;
}
