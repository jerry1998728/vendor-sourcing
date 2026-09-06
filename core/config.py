"""Loaders for configs/*.yaml (sourcing configs) and rulesets/*.yaml (screening rulesets)."""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml

from core.models import VENDOR_TYPES, RULE_OPS, Criterion, FieldSpec, Rule, Ruleset

PROJECT_ROOT = Path(__file__).resolve().parents[1]
CONFIGS_DIR = PROJECT_ROOT / "configs"
RULESETS_DIR = PROJECT_ROOT / "rulesets"


@dataclass(frozen=True)
class Config:
    adapter: str
    vendor_type: str
    ruleset: str                 # "name@version"
    seed_queries: tuple[str, ...]
    path: str


class ConfigError(ValueError):
    pass


def _read_yaml(path: Path) -> dict[str, Any]:
    with open(path, "r", encoding="utf-8") as fh:
        data = yaml.safe_load(fh) or {}
    if not isinstance(data, dict):
        raise ConfigError(f"{path}: top level must be a mapping")
    return data


def load_config(path: str | Path) -> Config:
    p = Path(path)
    if not p.is_absolute() and not p.exists():
        p = PROJECT_ROOT / p
    data = _read_yaml(p)
    for key in ("adapter", "vendor_type", "ruleset", "seed_queries"):
        if key not in data:
            raise ConfigError(f"{p}: missing required key {key!r}")
    if data["vendor_type"] not in VENDOR_TYPES:
        raise ConfigError(f"{p}: vendor_type must be one of {VENDOR_TYPES}")
    if "@" not in str(data["ruleset"]):
        raise ConfigError(f"{p}: ruleset must look like name@version")
    queries = tuple(str(q).strip() for q in data["seed_queries"] if str(q).strip())
    if not queries:
        raise ConfigError(f"{p}: seed_queries is empty")
    return Config(
        adapter=str(data["adapter"]),
        vendor_type=str(data["vendor_type"]),
        ruleset=str(data["ruleset"]),
        seed_queries=queries,
        path=str(p),
    )


def ruleset_path(ref: str) -> Path:
    """'ego_data_supplier@v1' -> rulesets/ego_data_supplier.v1.yaml (or a literal path)."""
    p = Path(ref)
    if p.suffix in (".yaml", ".yml") and (p.exists() or (PROJECT_ROOT / p).exists()):
        return p if p.exists() else PROJECT_ROOT / p
    if "@" not in ref:
        raise ConfigError(f"ruleset reference {ref!r} must be name@version or a yaml path")
    name, version = ref.split("@", 1)
    return RULESETS_DIR / f"{name}.{version}.yaml"


def _parse_rule(raw: dict[str, Any], where: str) -> Rule:
    if "field" not in raw or "op" not in raw:
        raise ConfigError(f"{where}: rule needs 'field' and 'op'")
    op = str(raw["op"])
    if op not in RULE_OPS:
        raise ConfigError(f"{where}: unknown op {op!r}; expected one of {RULE_OPS}")
    values = raw.get("values") or ()
    if isinstance(values, (str, int, float)):
        values = (values,)
    return Rule(
        field=str(raw["field"]), op=op, value=raw.get("value"),
        values=tuple(str(v) for v in values),
        min=float(raw["min"]) if raw.get("min") is not None else None,
        max=float(raw["max"]) if raw.get("max") is not None else None,
    )


def _parse_criterion(raw: dict[str, Any], kind: str, where: str) -> Criterion:
    if "key" not in raw:
        raise ConfigError(f"{where}: criterion needs a 'key'")
    key = str(raw["key"])
    if "rules" in raw:
        rules = tuple(_parse_rule(r, f"{where}:{key}") for r in raw["rules"])
    elif "field" in raw:
        rules = (_parse_rule(raw, f"{where}:{key}"),)
    else:
        raise ConfigError(f"{where}:{key}: criterion needs 'field'/'op' or a 'rules' list")
    combine = str(raw.get("combine", "all"))
    if combine not in ("all", "any", "min_pass"):
        raise ConfigError(f"{where}:{key}: combine must be all|any|min_pass")
    min_pass = raw.get("min_pass")
    if combine == "min_pass" and not min_pass:
        raise ConfigError(f"{where}:{key}: combine=min_pass needs min_pass: N")
    return Criterion(key=key, kind=kind, rules=rules, combine=combine,  # type: ignore[arg-type]
                     description=str(raw.get("description", "")), min_pass=int(min_pass) if min_pass else None)


def _parse_field(raw: dict[str, Any], where: str) -> FieldSpec:
    if "path" not in raw:
        raise ConfigError(f"{where}: field needs a 'path'")
    return FieldSpec(
        path=str(raw["path"]), type=str(raw.get("type", "string")),
        description=str(raw.get("description", "")),
        enum=tuple(str(v) for v in (raw.get("enum") or ())),
    )


def load_ruleset(ref: str) -> Ruleset:
    p = ruleset_path(ref)
    if not p.exists():
        raise ConfigError(f"ruleset file not found: {p}")
    data = _read_yaml(p)
    name = str(data.get("name") or p.stem.split(".")[0])
    version = str(data.get("version") or p.stem.split(".")[-1])
    if "@" in ref and ref != f"{name}@{version}":
        raise ConfigError(f"{p}: declares {name}@{version} but was referenced as {ref}")
    must = tuple(_parse_criterion(c, "must", f"{p}:must") for c in (data.get("must") or []))
    should = tuple(_parse_criterion(c, "should", f"{p}:should") for c in (data.get("should") or []))
    fields = tuple(_parse_field(f, f"{p}:fields") for f in (data.get("fields") or []))
    if not must:
        raise ConfigError(f"{p}: a ruleset needs at least one must-criterion")
    known = {f.path for f in fields}
    if known:
        for c in (*must, *should):
            for r in c.rules:
                if r.field not in known:
                    raise ConfigError(f"{p}: criterion {c.key} reads field {r.field!r} not in the fields catalog")
    return Ruleset(name=name, version=version, must=must, should=should, fields=fields,
                   description=str(data.get("description", "")), path=str(p))


def load_all_configs() -> dict[str, Config]:
    return {p.stem: load_config(p) for p in sorted(CONFIGS_DIR.glob("*.yaml"))}


def load_all_rulesets() -> dict[str, Ruleset]:
    out: dict[str, Ruleset] = {}
    for p in sorted(RULESETS_DIR.glob("*.yaml")):
        rs = load_ruleset(str(p))
        out[rs.version_string] = rs
    return out
