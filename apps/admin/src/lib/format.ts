/**
 * Fixed-locale, fixed-zone timestamp formatting.
 *
 * `toLocaleString()` with no arguments resolves differently on the server
 * (UTC on Railway) than in the browser, which produces a React hydration
 * mismatch in Client Components and silently mislabels times in Server
 * Components. An admin correlating an incident against the API's logs needs
 * an unambiguous, zone-labelled timestamp anyway — so everything here is
 * rendered in UTC and says so.
 */
const UTC_FORMAT = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "medium",
  timeStyle: "medium",
  timeZone: "UTC",
});

export function formatUTC(iso: string | null): string {
  if (!iso) return "—";
  return `${UTC_FORMAT.format(new Date(iso))} UTC`;
}
