import type { SessionMetrics } from '../biometric';
import { hrPathName } from '../hrPath';

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
 *
 * **N552/#1021 — it now names the PATH, not only the device.** The sentence
 * used to open "From …" in both cases, so "From your Amazfit GTR 4" and
 * "From Apple Health" read as two devices rather than as the two different
 * routes they are — and Settings had just spent a paragraph teaching the
 * athlete that the difference between those routes is the whole story (live
 * during the session versus filled in afterwards). The path names come from
 * `hrPathName`, the same function Settings renders, so the report cannot
 * call a path something Settings does not.
 */
export function hrSourceSentence(
  metrics: Pick<SessionMetrics, 'hr_source' | 'sample_count' | 'hr_direct_count'> | null,
  monitorName: string | null,
  sourceLabel: string,
): string | null {
  if (!metrics || metrics.hr_source === 'none' || metrics.sample_count <= 0) return null;
  const direct = metrics.hr_direct_count ?? 0;
  if (direct <= 0) return hrPathName('health', sourceLabel);
  const live = hrPathName('live', sourceLabel);
  const device = monitorName ? `your ${monitorName}` : 'your heart-rate monitor';
  const filled = metrics.sample_count - direct;
  if (filled <= 0) return `${live}, from ${device}`;
  return `${live}, from ${device} · ${filled} ${filled === 1 ? 'reading' : 'readings'} from ${sourceLabel} filled gaps`;
}
