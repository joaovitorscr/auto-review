import { db } from "./db";

export async function saveProfile(id: string, name: string) {
  console.info("saving profile", id);
  db.write(`profile:${id}`, { name });
  return { ok: true };
}
