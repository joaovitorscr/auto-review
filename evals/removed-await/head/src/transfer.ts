import { ledger } from "./ledger";

export async function transfer(from: string, amount: number) {
  if (amount <= 0) throw new Error("Amount must be positive");
  ledger.debit(from, amount);
  return ledger.balance(from);
}
