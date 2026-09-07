/**
 * Hover text for every Dashboard metric: what the number is, then why it
 * matters to the sourcing team. Plain data so the server page can pass it to
 * the client tooltip.
 */
export type MetricHelp = { what: string; why: string };

export type MetricId =
  | "vendors"
  | "coverage"
  | "unknown_rate"
  | "pipeline"
  | "backlog"
  | "funnel"
  | "screening"
  | "coverage_by_type"
  | "reply_rate"
  | "backlog_chart"
  | "runs"
  | "source"
  | "country";

export const METRIC_HELP: Record<MetricId, MetricHelp> = {
  vendors: {
    what: "Every vendor in the database, any status, from every source: web search, GitHub and manual upload.",
    why: "The size of the sourcing universe and the denominator of the funnel. It only grows with runs and uploads; if it stalls, discovery has stalled.",
  },
  coverage: {
    what: "Mean share of must-fields backed by verified evidence, across all vendors. A must-field is a hard screening criterion such as sensor rig or ownership country.",
    why: "How much of the screening is grounded rather than guessed. A pass at low coverage is provisional: the gaps become outreach questions, and a channel stuck at low coverage needs a different source.",
  },
  unknown_rate: {
    what: "Screened vendors with at least one must-field that has no verified evidence, divided by all screened vendors.",
    why: "This is the outreach-to-verify queue, not a defect. Unknown never rejects; it is driven down by asking vendors, never by guessing.",
  },
  pipeline: {
    what: "Vendors currently Contacted or In Discussion.",
    why: "The live conversations that need replies and follow-ups this week. Read it with the reply rate to see whether outreach converts.",
  },
  backlog: {
    what: "Review queue (Screened, awaiting a decision) plus pending proposals (inferred changes awaiting accept or reject) plus next actions past their due date.",
    why: "The human decisions waiting right now. The number to drive to zero each day; a growing backlog means discovery is outrunning review.",
  },
  funnel: {
    what: "Vendors that ever reached each status, counted from the event log, so a vendor counts at every step it passed through.",
    why: "Shows where vendors drop out. A narrow step after Screened means strict criteria or thin evidence; a narrow step after Contacted means replies are the bottleneck.",
  },
  screening: {
    what: "Screened vendors by outcome: pass (every must-field verified and passing), fail (verified evidence against a must-field), unknown (a must-field without verified evidence). The centre is the unknown rate.",
    why: "Pass is the shortlist, fail is the evidence-backed exclusion, unknown is the ask-before-deciding pile. The mix tells you whether to source more or verify more.",
  },
  coverage_by_type: {
    what: "Mean must-field coverage per vendor category.",
    why: "Which category's sources actually reveal the must-fields. Low coverage in a category means its adapter cannot find the evidence and manual research or another source is needed.",
  },
  reply_rate: {
    what: "Vendors that replied at least once, divided by vendors ever contacted. The caption is the median time from first email to first reply.",
    why: "Outreach quality and message fit. A low rate says revise the draft or the recipients; the median reply time sets the follow-up cadence.",
  },
  backlog_chart: {
    what: "Review queue, pending proposals, overdue next actions, and stale vendors with no verification in 30 days.",
    why: "What to work on today, in order. Stale vendors are the refresh candidates; their evidence may no longer hold.",
  },
  runs: {
    what: "Pass, unknown and fail counts for the last ten finished discovery runs, oldest to newest.",
    why: "Yield per run and per config. A run that is mostly unknown finds vendors but not evidence; compare configs here before spending on more searches.",
  },
  source: {
    what: "Vendors by the channel that discovered them: web search, GitHub organisations or manual upload.",
    why: "Dependence on a single channel. A one-channel database inherits that channel's blind spots.",
  },
  country: {
    what: "Vendors by registration country, top eight. Collection geography is a tag and is not shown here.",
    why: "Geographic concentration and the registration and ownership exclusions at a glance.",
  },
};
