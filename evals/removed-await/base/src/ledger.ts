const balances = new Map<string, number>([["alice", 100]]);

export const ledger = {
  async debit(account: string, amount: number) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    const current = balances.get(account) ?? 0;
    if (current < amount) throw new Error("Insufficient funds");
    balances.set(account, current - amount);
  },
  balance(account: string) {
    return balances.get(account) ?? 0;
  },
};
