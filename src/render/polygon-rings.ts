export function separatePolygonRings<Ring extends readonly unknown[]>(rings: readonly Ring[]): {
  outer: Ring | undefined;
  holes: Ring[];
} {
  const [first, ...inner] = rings;
  if (!first || first.length < 3) return { outer: undefined, holes: [] };
  return {
    outer: first,
    holes: inner.filter((ring) => ring.length >= 3),
  };
}
