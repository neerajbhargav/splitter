export type GroupKind = "home" | "trip" | "couple" | "other";
export type SplitType = "equal" | "exact" | "percent" | "shares";
export type RepeatInterval = "none" | "weekly" | "biweekly" | "monthly" | "yearly";

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

export type Expense = {
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
  placeholders: { id: string; display_name: string; color: string }[];
};

export type ExpenseInput = {
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
  upcoming_bill_shares: { member_id: string; amount_cents: number }[];
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
