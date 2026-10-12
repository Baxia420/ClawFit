// Date formatting shared by server pages and browser components.
export function localDate(timeZone = "Asia/Kuala_Lumpur") {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function formatLocalDate(value: string | Date, timeZone: string) {
  return new Intl.DateTimeFormat("en-MY", { timeZone, day: "2-digit", month: "short", year: "numeric" }).format(new Date(value));
}

export function formatLocalTime(value: string | Date, timeZone: string) {
  return new Intl.DateTimeFormat("en-MY", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(value));
}

