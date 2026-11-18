import { AxedaError } from '../errors.js';

/** Distancia de edición (Levenshtein) entre dos textos cortos. */
function distance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        (current[j - 1] ?? 0) + 1,
        (previous[j] ?? 0) + 1,
        (previous[j - 1] ?? 0) + cost,
      );
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}

/** La opción conocida más parecida, si se parece lo bastante para ser una errata. */
export function closestOption(name: string, known: readonly string[]): string | undefined {
  const lower = name.toLowerCase();
  let best: { option: string; score: number } | undefined;
  for (const option of known) {
    const score = distance(lower, option.toLowerCase());
    if (best === undefined || score < best.score) best = { option, score };
  }
  // Hasta un tercio del nombre, y como mucho 3: «invitationDelibery» sí, «foo» no.
  const limit = Math.min(3, Math.max(1, Math.floor(name.length / 3)));
  return best !== undefined && best.score <= limit ? best.option : undefined;
}

/**
 * Rechaza las opciones que nadie lee. Sin esto, una opción mal escrita (`invitationDelibery`) se
 * ignora en silencio y lo que configuraba queda apagado sin que nadie lo note. Lanza
 * `AXEDA_INVALID_CONFIG` con la opción desconocida y, si se parece a una conocida, cuál.
 */
export function rejectUnknownOptions(
  where: string,
  options: unknown,
  known: readonly string[],
): void {
  if (typeof options !== 'object' || options === null) return;
  for (const key of Object.keys(options)) {
    if (known.includes(key)) continue;
    const suggestion = closestOption(key, known);
    throw new AxedaError(
      'AXEDA_INVALID_CONFIG',
      `${where}: unknown option "${key}".${suggestion === undefined ? '' : ` Did you mean "${suggestion}"?`} ` +
        `Known options: ${known.join(', ')}.`,
      { details: { option: key, ...(suggestion === undefined ? {} : { suggestion }) } },
    );
  }
}
