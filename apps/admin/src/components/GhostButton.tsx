type GhostButtonProps = {
  children: React.ReactNode;
  variant?: "default" | "danger";
  onClick?: () => void;
};

export function GhostButton({ children, variant = "default", onClick }: GhostButtonProps) {
  const toneClasses =
    variant === "danger"
      ? "border-danger-border bg-danger-bg text-danger-text"
      : "border-border-strong text-button-text";

  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-[9px] border px-3.5 py-2.5 font-barlow-condensed text-[11px] font-semibold tracking-[0.14em] uppercase ${toneClasses}`}
    >
      {children}
    </button>
  );
}
