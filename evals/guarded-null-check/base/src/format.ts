export type User = { name: string; email: string } | null;

export function formatUser(user: User): string {
  if (!user) return "";
  return `${user.name} <${user.email}>`;
}
