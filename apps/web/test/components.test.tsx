// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import type { CaseEvent, GuardianCase } from "@guardian/shared";
import { ProtectiveActions, ReverseAuthSeal, RiskMeter, Timeline } from "@/components/CaseWidgets";

afterEach(cleanup);

const baseCase: GuardianCase = {
  id: "GUARD-4821",
  customerId: "c",
  transactionId: "t",
  channel: "sentinel_alert",
  status: "open",
  summary: "s",
  riskScore: 92,
  riskHistory: [],
  cardLocked: false,
  transactionFlagged: false,
  reverseAuth: null,
  humanReview: null,
  responses: [],
  createdAt: "2026-09-24T00:00:00Z",
  updatedAt: "2026-09-24T00:00:00Z",
};

const ev = (id: string, title: string): CaseEvent => ({ id, caseId: "GUARD-4821", sessionId: null, type: "tool_called", title, detail: "", actor: "Atlas", at: "2026-09-24T00:00:00Z" });

describe("RiskMeter", () => {
  it("exposes the score as an accessible meter", () => {
    render(<RiskMeter score={99} band="critical" />);
    const meter = screen.getByRole("meter", { name: "Fraud risk score" });
    expect(meter.getAttribute("aria-valuenow")).toBe("99");
    expect(meter.getAttribute("aria-valuetext")).toBe("99 out of 99, Critical");
    expect(screen.getByTestId("risk-score").textContent).toBe("99");
  });
});

describe("ReverseAuthSeal", () => {
  it("explains the idea before a phrase exists", () => {
    render(<ReverseAuthSeal auth={null} agentName="Atlas" />);
    expect(screen.getByTestId("reverse-auth-empty").textContent).toMatch(/proves it is the bank/);
  });

  it("shows the phrase and tells the customer what to do on a mismatch", () => {
    render(<ReverseAuthSeal auth={{ phrase: "BLUE MAPLE", issuedAt: "x", verified: false }} agentName="Atlas" />);
    expect(screen.getByTestId("reverse-auth-phrase").textContent).toBe("BLUE MAPLE");
    expect(screen.getByTestId("reverse-auth").textContent).toMatch(/hang up/);
  });

  it("confirms a verified match", () => {
    render(<ReverseAuthSeal auth={{ phrase: "BLUE MAPLE", issuedAt: "x", verified: true }} agentName="Atlas" />);
    expect(screen.getByTestId("reverse-auth-verified").textContent).toMatch(/Matched/);
  });
});

describe("Timeline", () => {
  it("renders oldest first by default and newest first on request, with a limit", () => {
    const events = [ev("1", "first"), ev("2", "second"), ev("3", "third")];
    const { rerender } = render(<Timeline events={events} />);
    expect(within(screen.getByTestId("timeline")).getAllByRole("listitem").map((li) => li.querySelector("p")?.textContent)).toEqual(["first", "second", "third"]);
    rerender(<Timeline events={events} limit={2} newestFirst />);
    expect(within(screen.getByTestId("timeline")).getAllByRole("listitem").map((li) => li.querySelector("p")?.textContent)).toEqual(["third", "second"]);
  });

  it("has an empty state", () => {
    render(<Timeline events={[]} />);
    expect(screen.getByText(/Nothing has happened/)).toBeTruthy();
  });
});

describe("ProtectiveActions", () => {
  it("marks completed mock actions and labels them for screen readers", () => {
    render(<ProtectiveActions c={{ ...baseCase, cardLocked: true, humanReview: { ticketId: "HR-1", priority: "urgent", status: "queued", summary: "", requestedAt: "" } }} />);
    expect(screen.getByTestId("action-lock").dataset.done).toBe("true");
    expect(screen.getByTestId("action-flag").dataset.done).toBe("false");
    expect(screen.getByTestId("action-lock").textContent).toMatch(/done.*locked \(mock\)/s);
    expect(screen.getByTestId("action-review").textContent).toMatch(/HR-1, urgent priority/);
  });
});
