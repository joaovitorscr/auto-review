export const db = {
  async write(key: string, value: unknown) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    store.set(key, value);
  },
};
const store = new Map<string, unknown>();
