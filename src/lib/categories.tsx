import {
  Car, CircleDollarSign, Film, HeartPulse, House, Plane, Receipt, ShoppingBag, ShoppingCart, Sofa, Users,
  Utensils, Wifi, Zap, Heart, type LucideIcon,
} from "lucide-react";
import type { GroupKind } from "./types";

export const CATEGORIES: { id: string; label: string; icon: LucideIcon }[] = [
  { id: "general", label: "General", icon: Receipt },
  { id: "groceries", label: "Groceries", icon: ShoppingCart },
  { id: "dining", label: "Dining out", icon: Utensils },
  { id: "rent", label: "Rent", icon: House },
  { id: "utilities", label: "Utilities", icon: Zap },
  { id: "internet", label: "Internet & phone", icon: Wifi },
  { id: "household", label: "Household", icon: Sofa },
  { id: "transport", label: "Transport", icon: Car },
  { id: "travel", label: "Travel", icon: Plane },
  { id: "entertainment", label: "Entertainment", icon: Film },
  { id: "shopping", label: "Shopping", icon: ShoppingBag },
  { id: "health", label: "Health", icon: HeartPulse },
];

const PAYMENT = { id: "payment", label: "Payment", icon: CircleDollarSign };

export function category(id: string) {
  if (id === "payment") return PAYMENT;
  return CATEGORIES.find((c) => c.id === id) ?? CATEGORIES[0];
}

export const GROUP_KINDS: { id: GroupKind; label: string; icon: LucideIcon }[] = [
  { id: "home", label: "Home", icon: House },
  { id: "trip", label: "Trip", icon: Plane },
  { id: "couple", label: "Couple", icon: Heart },
  { id: "other", label: "Other", icon: Users },
];

export function groupKind(id: string) {
  return GROUP_KINDS.find((k) => k.id === id) ?? GROUP_KINDS[3];
}
