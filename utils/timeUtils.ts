
/**
 * Converts standard H:M:S to Decimal Hours (e.g., 1:30:00 -> 1.5)
 */
export const toDecimalHours = (h: number, m: number, s: number): number => {
  return h + (m / 60) + (s / 3600);
};

/**
 * Converts Decimal Hours back to H:M:S
 */
export const fromDecimalHours = (decimal: number) => {
  const h = Math.floor(decimal);
  const m = Math.floor((decimal - h) * 60);
  const s = Math.round(((decimal - h) * 60 - m) * 60);
  return { h, m, s: s === 60 ? 59 : s };
};

/**
 * Converts standard time to French Revolutionary Decimal Time
 * 10 hours/day, 100 minutes/hour, 100 seconds/minute
 */
export const toFrenchDecimal = (date: Date): { h: number, m: number, s: number } => {
  const totalSecondsInDay = (date.getHours() * 3600) + (date.getMinutes() * 60) + date.getSeconds() + (date.getMilliseconds() / 1000);
  const decimalSecondsPerStandardSecond = 100000 / 86400;
  const totalDecimalSeconds = totalSecondsInDay * decimalSecondsPerStandardSecond;

  const h = Math.floor(totalDecimalSeconds / 10000);
  const m = Math.floor((totalDecimalSeconds % 10000) / 100);
  const s = Math.floor(totalDecimalSeconds % 100);

  return { h, m, s };
};

export const formatTwoDigits = (n: number): string => n.toString().padStart(2, '0');
export const formatThreeDigits = (n: number): string => n.toString().padStart(3, '0');
