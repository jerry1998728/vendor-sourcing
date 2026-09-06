"use client";

import * as React from "react";
import { ChevronDown, Plus, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";

/** GitHub linguist names accepted by the repository search `language:` qualifier. */
export const GITHUB_LANGUAGES = [
  "Python",
  "TypeScript",
  "JavaScript",
  "Go",
  "Rust",
  "Java",
  "Kotlin",
  "C",
  "C++",
  "C#",
  "Swift",
  "Objective-C",
  "Ruby",
  "PHP",
  "Scala",
  "Dart",
  "Elixir",
  "Erlang",
  "Haskell",
  "Clojure",
  "Shell",
  "R",
  "Julia",
  "Lua",
] as const;

/** Multi-select over the curated list plus any other linguist name typed in; the selection shows as removable chips. */
export function LanguageSelect({ id, value, onChange }: { id: string; value: string[]; onChange: (next: string[]) => void }) {
  const [other, setOther] = React.useState("");
  const has = (lang: string) => value.some((v) => v.toLowerCase() === lang.toLowerCase());
  const toggle = (lang: string, checked: boolean) => onChange(checked ? (has(lang) ? value : [...value, lang]) : value.filter((v) => v.toLowerCase() !== lang.toLowerCase()));
  const addOther = () => {
    const lang = other.trim();
    if (lang) toggle(lang, true);
    setOther("");
  };
  const options = [...GITHUB_LANGUAGES, ...value.filter((v) => !GITHUB_LANGUAGES.some((g) => g.toLowerCase() === v.toLowerCase()))];

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button id={id} type="button" variant="outline" className="w-48 justify-between font-normal" aria-label="Languages">
              {value.length ? `${value.length} language${value.length === 1 ? "" : "s"}` : "Select languages"}
              <ChevronDown className="text-muted-foreground" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-h-80 w-52 overflow-y-auto">
            <DropdownMenuLabel>GitHub languages</DropdownMenuLabel>
            {options.map((lang) => (
              <DropdownMenuCheckboxItem
                key={lang}
                checked={has(lang)}
                onCheckedChange={(c) => toggle(lang, c === true)}
                onSelect={(e) => e.preventDefault()}
              >
                {lang}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <Input
          aria-label="Other language"
          value={other}
          onChange={(e) => setOther(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addOther();
            }
          }}
          placeholder="Other (linguist name)"
          className="w-44"
        />
        <Button type="button" variant="outline" size="icon" aria-label="Add language" onClick={addOther} disabled={!other.trim()}>
          <Plus />
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-1">
        {value.map((lang) => (
          <Badge key={lang} variant="secondary" className="gap-1 pr-1">
            {lang}
            <button type="button" aria-label={`Remove ${lang}`} className="rounded-sm text-muted-foreground hover:text-foreground" onClick={() => toggle(lang, false)}>
              <X className="size-3" />
            </button>
          </Badge>
        ))}
        {value.length === 0 ? <span className="text-xs text-muted-foreground">Pick at least one language.</span> : null}
      </div>
    </div>
  );
}
