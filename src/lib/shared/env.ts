/** One definition of "development" for the caps, the simulate route and the as_of override. */
export function isDev(): boolean {
  return process.env.NODE_ENV !== "production";
}
