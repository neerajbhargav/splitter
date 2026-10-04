import { CREDIT_BUREAUS, type CreditBureau, type CreditScore } from "./finance-types.ts";

/** Common scoring models. Free text is allowed too, these are just quick picks. */
export const SCORE_MODELS = ["FICO 8", "FICO 9", "FICO 10", "VantageScore 3.0", "VantageScore 4.0"] as const;
export const SCORE_MIN = 250;
export const SCORE_MAX = 900;
/** After this many days a reading is worth refreshing. */
export const STALE_DAYS = 45;

export type ScoreBand = { label: string; tone: "pass" | "warn" | "fail" };

/** FICO and VantageScore bands differ a little; anything that isn't Vantage uses FICO's. */
export function scoreBand(score: number, model = ""): ScoreBand {
  if (/vantage/i.test(model)) {
    if (score >= 781) return { label: "Excellent", tone: "pass" };
    if (score >= 661) return { label: "Good", tone: "pass" };
    if (score >= 601) return { label: "Fair", tone: "warn" };
    if (score >= 500) return { label: "Poor", tone: "fail" };
    return { label: "Very poor", tone: "fail" };
  }
  if (score >= 800) return { label: "Exceptional", tone: "pass" };
  if (score >= 740) return { label: "Very good", tone: "pass" };
  if (score >= 670) return { label: "Good", tone: "pass" };
  if (score >= 580) return { label: "Fair", tone: "warn" };
  return { label: "Poor", tone: "fail" };
}

export function sortScores<T extends Pick<CreditScore, "as_of" | "created_at" | "id">>(scores: readonly T[]): T[] {
  return [...scores].sort((a, b) => a.as_of.localeCompare(b.as_of) || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
}

function dayNumber(iso: string): number {
  return Math.round(Date.parse(`${iso.slice(0, 10)}T00:00:00Z`) / 86_400_000);
}

export type BureauSummary = {
  bureau: CreditBureau;
  latest: CreditScore | null;
  /** The reading before the latest one using the same model, so changes compare like with like. */
  previous: CreditScore | null;
  change: number | null;
  /** Lowest and highest reading in the last 12 months. */
  low: number | null;
  high: number | null;
  count: number;
  days_old: number | null;
  stale: boolean;
};

export function summarizeBureaus(scores: readonly CreditScore[], today: string): BureauSummary[] {
  const yearAgo = dayNumber(today) - 365;
  return CREDIT_BUREAUS.map((bureau) => {
    const mine = sortScores(scores.filter((s) => s.bureau === bureau));
    const latest = mine.at(-1) ?? null;
    let previous: CreditScore | null = null;
    if (latest) {
      for (let i = mine.length - 2; i >= 0; i--) {
        if (mine[i].model.trim().toLowerCase() === latest.model.trim().toLowerCase()) { previous = mine[i]; break; }
      }
    }
    const recent = mine.filter((s) => dayNumber(s.as_of) >= yearAgo).map((s) => s.score);
    const daysOld = latest ? Math.max(0, dayNumber(today) - dayNumber(latest.as_of)) : null;
    return {
      bureau,
      latest,
      previous,
      change: latest && previous ? latest.score - previous.score : null,
      low: recent.length ? Math.min(...recent) : null,
      high: recent.length ? Math.max(...recent) : null,
      count: mine.length,
      days_old: daysOld,
      stale: daysOld !== null && daysOld > STALE_DAYS,
    };
  });
}

export type CreditOverview = {
  /** Average of each bureau's latest reading, rounded to a whole point. */
  average: number | null;
  reported: number;
  /** Gap between the highest and lowest latest reading among bureaus using the same model family. */
  spread: number | null;
  lowest: BureauSummary | null;
  insights: string[];
};

export function creditOverview(summaries: readonly BureauSummary[]): CreditOverview {
  const have = summaries.filter((s) => s.latest);
  const values = have.map((s) => s.latest!.score);
  const average = values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : null;
  // Spread only means something between scores from the same model; FICO and VantageScore differ by design.
  const family = (m: string) => (/vantage/i.test(m) ? "vantage" : /fico/i.test(m) ? "fico" : m.trim().toLowerCase());
  const groups = new Map<string, BureauSummary[]>();
  for (const s of have) groups.set(family(s.latest!.model), [...(groups.get(family(s.latest!.model)) ?? []), s]);
  const comparable = [...groups.values()].sort((a, b) => b.length - a.length)[0] ?? [];
  const cvals = comparable.map((s) => s.latest!.score);
  const spread = cvals.length >= 2 ? Math.max(...cvals) - Math.min(...cvals) : null;
  const lowest = comparable.length >= 2 ? comparable.reduce((a, b) => (b.latest!.score < a.latest!.score ? b : a)) : have.length ? have.reduce((a, b) => (b.latest!.score < a.latest!.score ? b : a)) : null;
  const insights: string[] = [];
  const missing = summaries.filter((s) => !s.latest);
  if (have.length && missing.length) insights.push(`Add ${missing.map((s) => label(s.bureau)).join(" and ")} to see all three side by side.`);
  if (groups.size > 1) {
    const odd = [...groups.values()].filter((g) => g !== comparable).flat();
    insights.push(`${odd.map((s) => `${label(s.bureau)} uses ${s.latest!.model || "a different model"}`).join(", ")}, so compare it with its own history rather than the other bureaus.`);
  }
  if (spread !== null && spread >= 40 && lowest) {
    insights.push(`${label(lowest.bureau)} is ${spread} points below your highest score. Pull that report and check for an error or an account the others don't show.`);
  }
  for (const s of have) {
    if (s.change !== null && s.change <= -20) insights.push(`${label(s.bureau)} dropped ${-s.change} points since ${s.previous!.as_of}. A new hard inquiry, a higher card balance or a late payment are the usual causes.`);
  }
  const stale = have.filter((s) => s.stale);
  if (stale.length) insights.push(`${stale.map((s) => label(s.bureau)).join(", ")} ${stale.length === 1 ? "hasn't" : "haven't"} been updated in over ${STALE_DAYS} days.`);
  return { average, reported: have.length, spread, lowest, insights };
}

function label(b: CreditBureau): string {
  return b === "equifax" ? "Equifax" : b === "experian" ? "Experian" : "TransUnion";
}

/** One row per date with each bureau's reading that day, for a line chart. Later readings on the same day win. */
export function scoreSeries(scores: readonly CreditScore[], sinceDate?: string): { date: string; equifax?: number; experian?: number; transunion?: number }[] {
  const rows = new Map<string, { date: string; equifax?: number; experian?: number; transunion?: number }>();
  for (const s of sortScores(scores)) {
    if (sinceDate && s.as_of < sinceDate) continue;
    const row = rows.get(s.as_of) ?? { date: s.as_of };
    row[s.bureau] = s.score;
    rows.set(s.as_of, row);
  }
  return [...rows.values()];
}

export function validateScore(input: { score: number; as_of: string }, today: string): string | null {
  if (!Number.isInteger(input.score) || input.score < SCORE_MIN || input.score > SCORE_MAX) return `Enter a score from ${SCORE_MIN} to ${SCORE_MAX}.`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.as_of) || Number.isNaN(Date.parse(`${input.as_of}T00:00:00Z`))) return "Choose the date of this score.";
  if (input.as_of > today) return "That date hasn't happened yet.";
  return null;
}
