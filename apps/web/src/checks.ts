const successfulStates = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
const pendingStates = new Set(["PENDING", "QUEUED", "IN_PROGRESS", "EXPECTED"]);

export type CheckTone = "success" | "pending" | "failure";

export function checkTone(state: string): CheckTone {
  if (successfulStates.has(state)) return "success";
  if (pendingStates.has(state)) return "pending";
  return "failure";
}
