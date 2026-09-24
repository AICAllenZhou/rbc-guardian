"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { GuardianMark } from "./GuardianMark";

const LINKS = [
  { href: "/", label: "Overview" },
  { href: "/demo", label: "Live demo" },
  { href: "/cases/GUARD-4821", label: "Command Center" },
  { href: "/settings", label: "Diagnostics" },
];

export function SiteHeader() {
  const path = usePathname();
  return (
    <header className="sticky top-0 z-30 border-b border-rule/70 bg-navy/90 backdrop-blur">
      <div className="mx-auto flex max-w-7xl items-center gap-3 px-4 py-3 sm:gap-6 sm:px-6">
        <Link href="/" className="flex shrink-0 items-center gap-2.5 whitespace-nowrap font-extrabold tracking-tight">
          <GuardianMark />
          <span>
            RBC Guardian <span className="hidden font-medium text-mist sm:inline">concept</span>
          </span>
        </Link>
        <nav aria-label="Primary" className="ml-auto flex gap-1 overflow-x-auto text-sm">
          {LINKS.map((l) => {
            const active = l.href === "/" ? path === "/" : path.startsWith(l.href.split("/").slice(0, 2).join("/"));
            return (
              <Link
                key={l.href}
                href={l.href}
                aria-current={active ? "page" : undefined}
                className={`whitespace-nowrap rounded-full px-3 py-1.5 font-semibold transition-colors ${active ? "bg-panel-2 text-paper" : "text-mist hover:text-paper"}`}
              >
                {l.label}
              </Link>
            );
          })}
        </nav>
      </div>
    </header>
  );
}
