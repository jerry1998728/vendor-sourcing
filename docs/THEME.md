# UI theme
Background #141414 · Surface #1A1A1A · Surface raised #202021 · Border #2A2A2A
Text primary #E7E7E8 · Text secondary #A1A1A1 · Icon default #353535
Accent #ED6941 (primary actions and active nav only) · Accent hover #F58A6A · Accent muted #83402B
Status badges: pass/qualified #4CAF7D · unknown/needs outreach #E0A83B · fail/rejected #D9534F
Rules: one accent; hierarchy via the four grays; status colors only on badges; never pure white.
Implement as CSS variables in globals.css mapped to shadcn tokens (--background, --card, --border, --primary, --foreground, --muted-foreground).
No third-party logos or wordmarks.

## Token mapping (globals.css, dark only)
```css
:root {
  --background: #141414;
  --card: #1A1A1A;
  --popover: #202021;
  --border: #2A2A2A;
  --input: #2A2A2A;
  --foreground: #E7E7E8;
  --muted-foreground: #A1A1A1;
  --primary: #ED6941;
  --primary-foreground: #141414;
  --accent: #83402B;
  --success: #4CAF7D;
  --warning: #E0A83B;
  --destructive: #D9534F;
}
```

## Streamlit equivalent (reference only, not used in the Next.js build)
```toml
[theme]
base = "dark"
primaryColor = "#ED6941"
backgroundColor = "#141414"
secondaryBackgroundColor = "#1A1A1A"
textColor = "#E7E7E8"
```

## Charts (Dashboard)
The accent marks the series that matters; every other series uses the four grays (`--chart-1` to `--chart-5`). Pass / unknown / fail keep the badge colours (`--success`, `--warning`, `--destructive`) so a screening outcome in a chart never contradicts the badge next to it. No chart animation: the final state paints on first render.
