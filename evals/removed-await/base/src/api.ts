import { transfer } from "./transfer";

export async function handleTransfer(body: { from: string; amount: number }) {
  try {
    const balance = await transfer(body.from, body.amount);
    return { status: 200, balance };
  } catch (error) {
    return { status: 400, error: String(error) };
  }
}
