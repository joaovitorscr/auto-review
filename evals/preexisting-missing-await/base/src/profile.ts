import { db } from "./db";

export async function saveProfile(id: string, name: string) {
  db.write(`profile:${id}`, { name });
  return { ok: true };
}
