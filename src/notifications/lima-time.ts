const limaParts = new Intl.DateTimeFormat("en-GB", {
  timeZone: "America/Lima",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** dd/mm/aaaa HH:mm in America/Lima, 24-hour clock. */
export function formatLimaDateTime(value: Date | string | number): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "no disponible";
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    limaParts.formatToParts(date).find((item) => item.type === type)?.value ??
    "";
  return `${part("day")}/${part("month")}/${part("year")} ${part("hour")}:${part("minute")}`;
}

/** "hace 5 min", "hace 3 h", "hace 2 d": coarse age to judge if the monitor is running. */
export function formatElapsed(
  value: Date | string | number,
  now = new Date(),
): string {
  const date = value instanceof Date ? value : new Date(value);
  const ms = now.getTime() - date.getTime();
  if (!Number.isFinite(ms)) return "";
  if (ms < 60_000) return "hace instantes";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `hace ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `hace ${hours} h`;
  return `hace ${Math.floor(hours / 24)} d`;
}
