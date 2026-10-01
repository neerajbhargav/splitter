import { money } from "./format";
import type { Group, Member } from "./types";

/** Opens the phone's SMS app or the mail app with a pre-written nudge. Nothing is sent automatically. */
export function reminderLink(debtor: Member, creditorName: string, cents: number, group: Group, origin: string): { href: string | null; text: string } {
  const text = `Hi ${debtor.display_name}, quick reminder from SPLITTER: you owe ${creditorName} ${money(cents, group.currency)} in "${group.name}". Details: ${origin}/groups/${group.id}`;
  if (debtor.phone) {
    const num = debtor.phone.replace(/[^\d+]/g, "");
    return { href: `sms:${num}?&body=${encodeURIComponent(text)}`, text };
  }
  if (debtor.email) {
    return { href: `mailto:${debtor.email}?subject=${encodeURIComponent(`SPLITTER: ${group.name}`)}&body=${encodeURIComponent(text)}`, text };
  }
  return { href: null, text };
}
