"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { LoaderCircle, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { postJson } from "@/lib/shared/http";

/**
 * Clone-and-edit: opens with the YAML of the selected ruleset, takes a new
 * name and version, and POSTs to /api/rulesets which validates and writes
 * rulesets/<name>.<version>.yaml. The caller selects the new ref on success.
 */
export function NewRulesetDialog({ cloneFrom, onCreated }: { cloneFrom: string; onCreated: (ref: string) => void }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState("");
  const [version, setVersion] = React.useState("v1");
  const [yaml, setYaml] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const onOpenChange = async (next: boolean) => {
    setOpen(next);
    if (!next) return;
    setError(null);
    setLoading(true);
    try {
      const res = await fetch(`/api/rulesets?ref=${encodeURIComponent(cloneFrom)}`, { cache: "no-store" });
      const data = (await res.json()) as { yaml?: string; error?: string };
      if (!res.ok || !data.yaml) throw new Error(data.error ?? `could not load ${cloneFrom}`);
      setYaml(data.yaml);
      setName(`${cloneFrom.split("@")[0]}_copy`);
      setVersion("v1");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const data = await postJson<{ ref: string }>("/api/rulesets", { name: name.trim(), version: version.trim(), yaml });
      setOpen(false);
      onCreated(data.ref);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => void onOpenChange(next)}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size="icon" aria-label="New ruleset" title={`New ruleset, starting from ${cloneFrom}`}>
          <Plus />
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>New ruleset</DialogTitle>
          <DialogDescription>
            Starts as a copy of {cloneFrom}. Edit <span className="font-mono">must</span> (hard gates: pass / fail / unknown), <span className="font-mono">should</span> (weighted ranking) and <span className="font-mono">fields</span> (what extraction looks for), then save.
            The file lands in rulesets/ and is selectable right away; runs record it as their ruleset_version.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="rs-name">Name</Label>
            <Input id="rs-name" className="w-64 font-mono text-xs" value={name} onChange={(e) => setName(e.target.value)} placeholder="ego_data_supplier_eu" />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="rs-version">Version</Label>
            <Input id="rs-version" className="w-24 font-mono text-xs" value={version} onChange={(e) => setVersion(e.target.value)} />
          </div>
          <span className="pb-2 text-xs text-muted-foreground">saved as rulesets/{name.trim() || "<name>"}.{version.trim() || "<version>"}.yaml</span>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="rs-yaml">Ruleset YAML</Label>
          <Textarea id="rs-yaml" rows={22} className="font-mono text-xs" value={yaml} onChange={(e) => setYaml(e.target.value)} disabled={loading} spellCheck={false} />
        </div>
        {error ? <p className="whitespace-pre-wrap text-sm text-destructive">{error}</p> : null}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={saving}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void save()} disabled={saving || loading || !name.trim() || !version.trim() || !yaml.trim()}>
            {saving ? <LoaderCircle className="animate-spin" /> : <Plus />}
            Save ruleset
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
