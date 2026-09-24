import { DISCLAIMER } from "@guardian/shared";

export function Disclaimer({ compact = false }: { compact?: boolean }) {
  if (compact) {
    return (
      <p className="t-small text-mist" data-testid="disclaimer-inline">
        {DISCLAIMER}
      </p>
    );
  }
  return (
    <footer className="border-t border-rule/70 bg-navy">
      <div className="mx-auto flex max-w-7xl flex-col gap-1 px-4 py-5 sm:px-6 md:flex-row md:items-center md:justify-between">
        <p className="t-small font-semibold text-paper" data-testid="disclaimer">
          {DISCLAIMER}
        </p>
        <p className="t-small text-mist">Browser voice only. No telephony, no real accounts, no real customer data.</p>
      </div>
    </footer>
  );
}
