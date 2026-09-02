import { createApproval, getSession, type ApprovalRecord } from "../store.js";
import { validateTwilioCallInput, type TwilioCallInput } from "./twilio.js";

/** Creates the same one-time approval record used by model-initiated calls. */
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
    args: { phoneNumber: call.phoneNumber, purpose: call.purpose },
    request: request.trim().slice(0, 1200) || `/call ${call.phoneNumber} ${call.purpose}`,
    history: session.history,
    model: session.model,
  });
}
