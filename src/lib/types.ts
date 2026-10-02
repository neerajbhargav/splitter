export type GroupKind = "home" | "trip" | "couple" | "other";
export type SplitType = "equal" | "exact" | "percent" | "shares";
export type RepeatInterval = "none" | "weekly" | "biweekly" | "monthly" | "yearly";

export type ExpenseItem = { description: string; amount_cents: number; member_ids: string[] };
export type DefaultSplit = { type: "equal" | "percent" | "shares"; members: { member_id: string; weight: number }[] };
export type FxMetadata = { source_currency: string | null; source_amount_cents: number | null; fx_rate: number | null; fx_date: string | null };

export type Profile = {
  id: string;
  display_name: string;
  email: string | null;
  avatar_url: string | null;
  default_currency: string;
};

export type Group = {
  id: string;
  name: string;
  kind: GroupKind;
  currency: string;
  simplify_debts: boolean;
  default_split?: DefaultSplit | null;
  invite_code: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type Member = {
  id: string;
  group_id: string;
  user_id: string | null;
  display_name: string;
  email: string | null;
  phone: string | null;
  color: string;
  role: "owner" | "member";
  is_active: boolean;
  created_at: string;
};

export type Share = { member_id: string; amount_cents: number; weight?: number | null };

export type Expense = Partial<FxMetadata> & {
  items?: ExpenseItem[];
  source_items?: ExpenseItem[];
  source_tax_cents?: number;
  source_tip_cents?: number;
  tax_cents?: number;
  tip_cents?: number;
  id: string;
  group_id: string;
  description: string;
  amount_cents: number;
  currency: string;
  category: string;
  expense_date: string;
  notes: string | null;
  split_type: SplitType;
  is_payment: boolean;
  receipt_path: string | null;
  repeat_interval: RepeatInterval;
  next_repeat_on: string | null;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  expense_payers: Share[];
  expense_splits: Share[];
};

export type Comment = {
  id: string;
  expense_id: string;
  group_id: string;
  user_id: string | null;
  body: string;
  created_at: string;
};

export type ActivityItem = {
  id: string;
  group_id: string;
  expense_id: string | null;
  actor_id: string | null;
  kind: string;
  summary: string;
  amount_cents: number | null;
  created_at: string;
};

export type Invite = {
  group_id: string;
  name: string;
  kind: GroupKind;
  member_count: number;
  already_member: boolean;
  me_name?: string | null;
  suggested?: { member_id: string; how: "email" | "name" } | null;
  placeholders: { id: string; display_name: string; color: string; looks_like_me?: boolean }[];
};

export type ExpenseInput = Partial<FxMetadata> & {
  items?: ExpenseItem[];
  source_items?: ExpenseItem[];
  source_tax_cents?: number;
  source_tip_cents?: number;
  tax_cents?: number;
  tip_cents?: number;
  description: string;
  amount_cents: number;
  category: string;
  expense_date: string;
  notes: string;
  split_type: SplitType;
  is_payment: boolean;
  receipt_path?: string | null;
  repeat_interval: RepeatInterval;
  payers: { member_id: string; amount_cents: number }[];
  splits: { member_id: string; amount_cents: number; weight?: number | null }[];
};

export type UpcomingBill = {
  id: string;
  group_id: string;
  title: string;
  amount_cents: number;
  due_date: string | null;
  is_estimate: boolean;
  category: string;
  notes: string | null;
  status: "upcoming" | "paid";
  expense_id: string | null;
  created_at: string;
  created_by?: string | null;
  upcoming_bill_shares: { member_id: string; amount_cents: number; paid_at?: string | null; paid_marked_by?: string | null }[];
};

export type UpcomingInput = {
  title: string;
  amount_cents: number;
  due_date: string | null;
  is_estimate: boolean;
  category: string;
  notes: string;
  shares: { member_id: string; amount_cents: number }[];
};
