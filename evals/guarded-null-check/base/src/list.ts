import { formatUser, type User } from "./format";

export function recipients(users: User[]): string[] {
  return users.filter((user) => user !== null).map((user) => formatUser(user));
}
