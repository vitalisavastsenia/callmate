import {
  IdSchema, InstantSchema, VersionSchema, type BookingPolicyPort, type CallSnapshot, type Offer,
} from "@callmate/contracts";
import { offersEqual } from "../booking/evidence.js";

export type PolicyInput = Parameters<BookingPolicyPort["evaluate"]>[0];
export type ExactOfferGrant = NonNullable<PolicyInput["grant"]>;
export type GrantCheck = { status: "absent" | "valid" }
  | { status: "invalid"; reason: "invalid_grant" | "grant_mismatch" | "grant_expired" };
const keys = ["approvalId", "attemptId", "planId", "planVersion", "offerId", "offerVersion", "expiresAt"];

/** Checks a backend-resolved grant; authenticity/revocation cannot be inferred from a JSON shape. */
export function checkExactOfferGrant(
  snapshot: CallSnapshot, offer: Offer, now: string, grant: PolicyInput["grant"],
): GrantCheck {
  if (grant === null) return { status: "absent" };
  if (!grant || typeof grant !== "object" || Object.keys(grant).length !== keys.length
    || Object.keys(grant).some((key) => !keys.includes(key))
    || ![grant.approvalId, grant.attemptId, grant.planId, grant.offerId].every((id) => IdSchema.safeParse(id).success)
    || ![grant.planVersion, grant.offerVersion].every((version) => VersionSchema.safeParse(version).success)
    || !InstantSchema.safeParse(grant.expiresAt).success || !InstantSchema.safeParse(now).success) {
    return { status: "invalid", reason: "invalid_grant" };
  }
  if (grant.attemptId !== snapshot.id || grant.planId !== snapshot.plan.id || grant.planVersion !== snapshot.plan.version
    || grant.offerId !== offer.id || grant.offerVersion !== offer.version
    || !snapshot.activeOffer || !offersEqual(offer, snapshot.activeOffer)) {
    return { status: "invalid", reason: "grant_mismatch" };
  }
  if (Date.parse(now) >= Date.parse(grant.expiresAt)) return { status: "invalid", reason: "grant_expired" };
  const pending = snapshot.pendingApproval;
  if (pending && (pending.id !== grant.approvalId || Date.parse(pending.expiresAt) !== Date.parse(grant.expiresAt)
    || !offersEqual(pending.offer, offer) || Date.parse(now) < Date.parse(pending.createdAt))) {
    return { status: "invalid", reason: "grant_mismatch" };
  }
  return { status: "valid" };
}
