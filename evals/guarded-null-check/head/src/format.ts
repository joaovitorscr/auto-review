export type User = { name: string; email: string } | null;

export function formatUser(user: NonNullable<User>): string {
  return `${user.name} <${user.email}>`;
}
