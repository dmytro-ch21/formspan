export type PillTone = "success" | "danger" | "neutral";

const toneClasses: Record<PillTone, string> = {
  success: "bg-success-bg text-success-text",
  danger: "bg-danger-bg text-danger-text",
  neutral: "bg-neutral-bg text-text-muted",
};

export function StatusPill({ tone, children }: { tone: PillTone; children: React.ReactNode }) {
  return (
    <span
      className={`rounded-full px-2.5 py-1 font-barlow-condensed text-[10px] font-bold tracking-[0.1em] whitespace-nowrap ${toneClasses[tone]}`}
    >
      {children}
    </span>
  );
}
