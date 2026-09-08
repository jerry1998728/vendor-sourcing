"use client";

/**
 * The due-diligence checklist for a vendor under evaluation. Each item is one
 * row that summarises its answer; opening it records a new one. An answer
 * counts only with a source URL or an attestation, the same rule every other
 * value in the database follows.
 */
import * as React from "react";
import { useRouter } from "next/navigation";
import { Check, ExternalLink, LoaderCircle, Minus, X } from "lucide-react";

import { DetailsToggle } from "@/components/details-toggle";
import { HelpLabel } from "@/components/help-label";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { Vendor } from "@/lib/db/schema";
import { DILIGENCE_STAGES } from "@/lib/db/enums";
import { formatDate } from "@/lib/format";
import { postJson } from "@/lib/shared/http";
import type { DiligenceAnswer, DiligenceStatus, DiligenceValue } from "@/lib/track/diligence";
import { cn } from "@/lib/utils";

const VALUE_LABEL: Record<DiligenceValue, string> = { pass: "pass", fail: "fail", na: "not applicable" };
const VALUE_CLASS: Record<DiligenceValue, string> = {
  pass: "border-success/40 bg-success/15 text-success",
  fail: "border-destructive/40 bg-destructive/15 text-destructive",
  na: "border-border text-muted-foreground",
};
const VALUE_ICON = { pass: Check, fail: X, na: Minus } as const;

function summarise(a: DiligenceAnswer): string {
  if (!a.value) return a.item.required ? "not checked yet · required" : "not checked yet";
  const who = a.source_url ? "source recorded" : a.attested_by ? `attested by ${a.attested_by}` : "unverified, does not count";
  return `${VALUE_LABEL[a.value]} · ${who}${a.answered_at ? ` · ${formatDate(a.answered_at).slice(0, 10)}` : ""}`;
}

function AnswerForm({ vendorId, answer, onSaved }: { vendorId: string; answer: DiligenceAnswer; onSaved: () => void }) {
  const [value, setValue] = React.useState<DiligenceValue>(answer.value ?? "pass");
  const [note, setNote] = React.useState(answer.note ?? "");
  const [sourceUrl, setSourceUrl] = React.useState(answer.source_url ?? "");
  const [attest, setAttest] = React.useState(Boolean(answer.attested_by));
  const [attester, setAttester] = React.useState(answer.attested_by ?? "");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const id = answer.item.id;

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await postJson<DiligenceStatus>(`/api/vendors/${encodeURIComponent(vendorId)}/diligence`, {
        item_id: id,
        value,
        note: note.trim() || undefined,
        source_url: sourceUrl.trim() || undefined,
        attested_by: attest ? attester.trim() || "me" : undefined,
      });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const willCount = Boolean(sourceUrl.trim() || attest);

  return (
    <div className="flex flex-col gap-3">
      {answer.item.description ? <p className="text-sm text-muted-foreground">{answer.item.description}</p> : null}
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`dg-${id}-value`}>Result</Label>
          <Select value={value} onValueChange={(v) => setValue(v as DiligenceValue)}>
            <SelectTrigger id={`dg-${id}-value`} className="w-40" aria-label="Result">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="pass">pass</SelectItem>
              <SelectItem value="fail">fail</SelectItem>
              <SelectItem value="na">not applicable</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex min-w-64 flex-1 flex-col gap-1.5">
          <Label htmlFor={`dg-${id}-source`}>Source URL</Label>
          <Input id={`dg-${id}-source`} value={sourceUrl} onChange={(e) => setSourceUrl(e.target.value)} placeholder="https://… the document or page you checked" />
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`dg-${id}-note`}>Note</Label>
        <Textarea id={`dg-${id}-note`} rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What you checked and what you found" />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Checkbox id={`dg-${id}-attest`} checked={attest} onCheckedChange={(c) => setAttest(c === true)} />
        <Label htmlFor={`dg-${id}-attest`} className="font-normal">I attest to this without a source URL</Label>
        {attest ? <Input aria-label="Attested by" className="h-8 w-56" value={attester} onChange={(e) => setAttester(e.target.value)} placeholder="you@company.com" /> : null}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" size="sm" onClick={() => void save()} disabled={busy}>
          {busy ? <LoaderCircle className="animate-spin" /> : <Check />}
          Save answer
        </Button>
        {!willCount ? <span className="text-xs text-warning">Without a source URL or an attestation this is recorded but does not count as done.</span> : null}
      </div>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </div>
  );
}

export function Diligence({ vendor, status }: { vendor: Vendor; status: DiligenceStatus }) {
  const router = useRouter();
  const [stageBusy, setStageBusy] = React.useState(false);
  const [stageError, setStageError] = React.useState<string | null>(null);

  // The server owns the status; saving re-renders the page with the new one.
  const onSaved = () => router.refresh();

  const setStage = async (stage: string) => {
    setStageBusy(true);
    setStageError(null);
    try {
      await postJson(`/api/vendors/${encodeURIComponent(vendor.vendor_id)}/transition`, {
        to_status: "In Discussion",
        to_stage: stage,
        reason: `diligence: moved to ${stage}`,
      });
      router.refresh();
    } catch (err) {
      setStageError(err instanceof Error ? err.message : String(err));
    } finally {
      setStageBusy(false);
    }
  };

  if (status.total === 0) {
    return <p className="text-sm text-muted-foreground">This vendor&apos;s ruleset defines no diligence checklist. Add a <span className="font-mono">diligence:</span> section to it.</p>;
  }

  const categories = status.by_category;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <HelpLabel help="Checks a human makes on a vendor under evaluation. The list comes from the vendor's ruleset. An answer counts only with a source URL or your attestation, the same rule every other value follows, and each one is written to the Timeline.">
          <span className="font-medium">
            {status.done} of {status.total} checked
          </span>
        </HelpLabel>
        <Badge variant="outline">{status.required_done} of {status.required_total} required</Badge>
        {categories.map((c) => (
          <Badge key={c.category} variant="secondary" className="font-normal">
            {c.category} {c.done}/{c.total}
          </Badge>
        ))}
        {vendor.status === "In Discussion" ? (
          <span className="ml-auto flex items-center gap-2">
            <Label htmlFor="dg-stage" className="text-xs text-muted-foreground">Stage</Label>
            <Select value={vendor.diligence_stage ?? "responded"} onValueChange={(v) => void setStage(v)} disabled={stageBusy}>
              <SelectTrigger id="dg-stage" className="h-8 w-48" aria-label="Diligence stage">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DILIGENCE_STAGES.map((s) => (
                  <SelectItem key={s} value={s}>{s}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </span>
        ) : null}
      </div>
      {stageError ? <p className="text-sm text-destructive">{stageError}</p> : null}

      <div className="flex flex-col gap-2">
        {status.answers.map((a) => {
          const Icon = a.value ? VALUE_ICON[a.value] : null;
          return (
            <DetailsToggle
              key={a.item.id}
              label={
                <span className="flex items-center gap-2">
                  {Icon ? (
                    <Badge variant="outline" className={cn("gap-1 px-1.5 py-0", a.verified ? VALUE_CLASS[a.value!] : "border-warning/40 text-warning")}>
                      <Icon className="size-3" />
                      {a.verified ? "" : "unverified"}
                    </Badge>
                  ) : (
                    <span aria-hidden className="size-2 rounded-full bg-muted-foreground/40" />
                  )}
                  {a.item.label}
                  {a.item.required ? <span className="text-xs text-muted-foreground">required</span> : null}
                </span>
              }
              summary={summarise(a)}
            >
              <div className="flex flex-col gap-3">
                {a.value ? (
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <span>Last answer: {VALUE_LABEL[a.value]}</span>
                    {a.note ? <span>· {a.note}</span> : null}
                    {a.source_url ? (
                      <a href={a.source_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline-offset-2 hover:underline">
                        source <ExternalLink className="size-3" />
                      </a>
                    ) : null}
                  </div>
                ) : null}
                <AnswerForm vendorId={vendor.vendor_id} answer={a} onSaved={onSaved} />
              </div>
            </DetailsToggle>
          );
        })}
      </div>
    </div>
  );
}
