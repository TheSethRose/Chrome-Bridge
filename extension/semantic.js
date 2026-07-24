export function normalizeSemanticValue(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

export function semanticNodeMatches(node, query) {
  const role = normalizeSemanticValue(query.role);
  const values = [node.name?.value, node.value?.value, node.description?.value];
  const matches = (actual, requested) => {
    if (!requested) return true;
    const value = normalizeSemanticValue(actual);
    const expected = normalizeSemanticValue(requested);
    return query.exact ? value === expected : value.includes(expected);
  };
  return (!role || normalizeSemanticValue(node.role?.value) === role)
    && matches(node.name?.value, query.name)
    && (!query.text || (query.exact ? values.some((value) => matches(value, query.text)) : matches(values.join(" "), query.text)));
}

export function selectSemanticMatch(matches, nth) {
  if (!matches.length) return { outcome: "no-match" };
  if (nth === undefined && matches.length > 1) return { outcome: "ambiguous" };
  const index = nth === undefined ? 0 : Number(nth);
  if (!Number.isInteger(index) || index < 0 || index >= matches.length) return { outcome: "out-of-range", index };
  return { outcome: "match", index, match: matches[index] };
}
