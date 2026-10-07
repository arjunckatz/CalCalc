/** Canonical Gregorian calendar dates, independent of clocks and timezones. */
export function isCanonicalLocalDate(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length !== 10 ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value)
  ) {
    return false;
  }
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  return (
    year >= 1 &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth(year, month)
  );
}

/** Returns null when yesterday would fall outside the supported 0001–9999 range. */
export function previousCalendarDate(currentLocalDate: string): string | null {
  if (!isCanonicalLocalDate(currentLocalDate)) return null;
  let year = Number(currentLocalDate.slice(0, 4));
  let month = Number(currentLocalDate.slice(5, 7));
  let day = Number(currentLocalDate.slice(8, 10));
  if (day > 1) {
    day -= 1;
  } else {
    if (month === 1) {
      if (year === 1) return null;
      year -= 1;
      month = 12;
    } else {
      month -= 1;
    }
    day = daysInMonth(year, month);
  }
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function daysInMonth(year: number, month: number): number {
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][
    month - 1
  ]!;
}
