import { toSlug } from "./slug";

export function postUrl(title: string) {
  return `/posts/${toSlug(title)}`;
}
