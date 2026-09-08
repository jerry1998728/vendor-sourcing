"use client";

import { HelpLabel } from "@/components/help-label";

import type { MetricHelp } from "./metric-help";

/** A metric name that explains itself on hover or focus: what it is, then why it matters. */
export function MetricLabel({ label, help }: { label: string; help: MetricHelp }) {
  return (
    <HelpLabel
      label={`${label}: definition and business impact`}
      help={
        <>
          <p>
            <span className="font-semibold">What it is.</span> {help.what}
          </p>
          <p>
            <span className="font-semibold">Why it matters.</span> {help.why}
          </p>
        </>
      }
    >
      {label}
    </HelpLabel>
  );
}
