export function sum(values) {
  if (!Array.isArray(values)) throw new TypeError("Expected an array of numbers.");

  let total = 0;
  for (const value of values) {
    if (!Number.isFinite(value)) throw new TypeError("Expected a finite number.");
    total += value;
  }
  return total;
}
