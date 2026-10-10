import { slug } from "./slug";

export function postUrl(title: string) {
  return `/posts/${slug(title)}`;
}
