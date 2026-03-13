export function compileSafeRegex(source: string, flags = ""): RegExp {
  return new RegExp(source, flags);
}
