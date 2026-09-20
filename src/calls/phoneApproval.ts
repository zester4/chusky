import { createApproval, getSession, type ApprovalRecord } from "../store.js";
import { validateTwilioCallInput, type TwilioCallInput } from "./twilio.js";

/** Legacy compatibility helper for already-supported approval flows. New call
 * routes and model-initiated calls start through CHUCK_START_PHONE_CALL after
 * normal validation and do not create an approval. */
export async function requestPhoneCallApproval(
  userId: number,
  input: TwilioCallInput,
  request = "",
): Promise<ApprovalRecord> {
  const call = validateTwilioCallInput(input);
  const session = await getSession(userId);
  return createApproval({
    userId,
    toolSlug: "CHUCK_START_PHONE_CALL",
    args: { phoneNumber: call.phoneNumber, purpose: call.purpose, profile: call.profile, ...(input.callProfile ? { callProfile: call.callProfile } : {}) },
    request: request.trim().slice(0, 1200) || `/call ${call.phoneNumber} ${call.purpose}`,
    history: session.history,
    model: session.model,
  });
}
