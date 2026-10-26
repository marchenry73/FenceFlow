/**
 * Can this company actually take a card payment right now?
 *
 * ONE ANSWER, because there were three and two of them were wrong in the same
 * direction.
 *
 * The quote page asked it, the contract email asked it, and each had its own
 * copy. Both Stripe copies were the EXACT INVERSE of the condition that works:
 * they required a connected-account id, which is the one configuration
 * create-payment-link REFUSES with a 501 (a link on a connected account raises
 * its webhook on that account, and stripe-webhook never hears it). The
 * configuration that mints is the one with NO connected id -- the platform
 * account -- and that read as "not ready".
 *
 * Measured, not argued: of 11 companies, 0 have an external_id and 0 have a
 * legacy stripe_account_id. So the old predicate was false for every company
 * on the system, which is why no quote ever drew a card button and no contract
 * email ever mentioned paying by card -- while the checkout behind both worked
 * perfectly.
 *
 * Correcting each copy in place would have left three copies that merely
 * happen to agree today. This is the copy.
 */
export function paymentsReadyFrom(
  conn: { processor?: unknown; external_id?: unknown; access_token?: unknown } | null,
  plan: string | null,
): boolean {
  // A read that failed is not permission to offer a button. Null means "we do
  // not know", and not knowing is not a yes.
  if (plan === null) return false;
  // Card payments are part of the Crew plan: create-payment-link answers 403
  // to a Solo company above the processor branch, so offering the button there
  // is a control that cannot work. A blank plan predates plans and is allowed.
  if (String(plan).toLowerCase() === "solo") return false;
  const processor = String(conn?.processor ?? "none").toLowerCase();
  // Square needs a real connection: the access token is what charges the card,
  // and the merchant id is what identifies where the money lands.
  if (processor === "square") return !!(conn?.access_token && conn?.external_id);
  // The Stripe path, including a company with no connection row at all --
  // which is the ordinary case and the one that works. A connected account id
  // is what gets refused, so the only configuration that mints is the one
  // without one.
  return !String(conn?.external_id ?? "").trim();
}
