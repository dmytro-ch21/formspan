import type { SessionMetrics } from '../biometric';

/**
 * N528/#958 — the report says where its numbers came from, so an athlete
 * can tell "from your Amazfit" apart from "from Apple Health" (the ticket's
 * own criterion). Pure: three facts in, one sentence (or nothing) out.
 *
 * `hr_direct_count` is the server's count of samples this app recorded from
 * the monitor (`MergeHRSources`); the rest of `sample_count` came from the
 * platform's health store to fill gaps in the direct stream. The monitor's
 * NAME is local — the phone that paired it remembers it — so a session
 * recorded with a monitor the athlete has since forgotten reads "your
 * heart-rate monitor".
 */
export function hrSourceSentence(
  metrics: Pick<SessionMetrics, 'hr_source' | 'sample_count' | 'hr_direct_count'> | null,
  monitorName: string | null,
  sourceLabel: string,
): string | null {
  if (!metrics || metrics.hr_source === 'none' || metrics.sample_count <= 0) return null;
  const direct = metrics.hr_direct_count ?? 0;
  if (direct <= 0) return `From ${sourceLabel}`;
  const device = monitorName ? `your ${monitorName}` : 'your heart-rate monitor';
  const filled = metrics.sample_count - direct;
  if (filled <= 0) return `From ${device}`;
  return `From ${device} · ${filled} ${filled === 1 ? 'reading' : 'readings'} from ${sourceLabel} filled gaps`;
}
