import Link from "next/link";

import { AdminMasthead } from "../../AdminMasthead";

/**
 * How to write a technique so the app can render it.
 *
 * This exists because **the Description field is parsed, not just displayed**,
 * and nothing in the form said so. `executionSteps` in `apps/mobile` splits it
 * into a numbered sequence; the two ways an author would most naturally write a
 * step list — numbering the steps, or bulleting them — are the two that break
 * it, and one of them fails *silently* by falling back to a paragraph.
 *
 * Every claim on this page was checked by running the real parser against the
 * input in question rather than by reading it. If `executionSteps` changes, the
 * table here is wrong and needs re-running — it is documentation of behaviour,
 * not of intent.
 */

export const metadata = { title: "Writing guide" };

export default function GuidePage() {
  return (
    <div className="min-h-screen w-full">
      <AdminMasthead
        title="Writing guide"
        section="content"
        meta="How the app reads what you type"
      />

      <main className="flex max-w-3xl flex-col gap-8 px-10 py-8">
        <p className="text-[13px] leading-relaxed text-text-secondary">
          Most fields here are shown as written. <strong className="text-text">Description is
          not</strong> — the app splits it into a numbered sequence, and how you punctuate it
          decides whether that works. This page is the rules, and the examples are the actual
          output of the parser.
        </p>

        <Guide />
      </main>
    </div>
  );
}

function Guide() {
  return (
    <>
      <section className="flex flex-col gap-3">
        <H>Description — “How it works”</H>
        <p className="text-[13px] leading-relaxed text-text-secondary">
          Write it as <strong className="text-text">one ordinary sentence, clauses separated
          by commas</strong>. The app splits on commas, semicolons and full stops, numbers the
          pieces, and renders them as steps an athlete can follow between rounds. Do not number
          or bullet them yourself — see below for what that produces.
        </p>

        <Example
          verdict="good"
          label="One sentence, comma-separated"
          input="Grip the far collar deep, step your lead foot across the hip, and fall back while pulling the elbow tight."
          output={[
            "Grip the far collar deep",
            "Step your lead foot across the hip",
            "Fall back while pulling the elbow tight",
          ]}
        />

        <Example
          verdict="good"
          label="One step per line, each ending in a full stop"
          input={"Grip the far collar.\nStep your foot across.\nFall back and finish."}
          output={["Grip the far collar", "Step your foot across", "Fall back and finish"]}
        />

        <Example
          verdict="bad"
          label="Numbering them yourself"
          input="1. Grip the far collar. 2. Step your foot across. 3. Fall back."
          output={["1", "Grip the far collar, 2", "Step your foot across, 3, Fall back"]}
          note="The numbers become steps of their own and the text runs together. This is the worst case because it is visibly wrong in the app rather than quietly plain."
        />

        <Example
          verdict="bad"
          label="Bullets, or lines with no punctuation"
          input={"- Grip the far collar\n- Step your foot across\n- Fall back"}
          output={null}
          note="A line break is not a separator. With nothing to split on, the whole thing stays one paragraph — the hyphens show up as literal text."
        />

        <Example
          verdict="bad"
          label="Clauses shorter than 10 characters"
          input="Break the grip, step in, and finish."
          output={null}
          note="This is the trap worth remembering. Fragments under ten characters are folded back into the clause before them, so “step in” and “finish” collapse into the first step — and a single step is rendered as a paragraph instead of a list. Nothing warns you. Write “step your hips in” and “finish the choke” and it works."
        />

        <Callout>
          Two things follow from the rules above. <strong className="text-text">A description
          that yields fewer than two steps is shown as a paragraph</strong>, which is deliberate
          — a one-item numbered list reads as a bug. And <strong className="text-text">a
          technique that genuinely is one action should just be one sentence</strong>; you do
          not need to invent steps for it.
        </Callout>
      </section>

      <section className="flex flex-col gap-3">
        <H>When to use</H>
        <p className="text-[13px] leading-relaxed text-text-secondary">
          Plain prose, not parsed, shown as written. This answers <em>when the mechanics
          apply</em> — the grip you are already holding, the reaction that opens it, the
          position you get it from. Keep it out of the description: merged, they answer neither
          question well, and the description would stop splitting cleanly.
        </p>
      </section>

      <section className="flex flex-col gap-3">
        <H>Names, and the three graph fields</H>
        <p className="text-[13px] leading-relaxed text-text-secondary">
          <Code>Setup from</Code>, <Code>Common next moves</Code> and <Code>Common
          counters</Code> are matched against other techniques <strong className="text-text">by
          name, exactly</strong>. A near-miss is not an error and not a warning — the edge
          simply does not resolve, and the app shows nothing where a link should be. Copy the
          name from the other technique rather than typing it.
        </p>
        <p className="text-[13px] leading-relaxed text-text-secondary">
          This is also why <Code>Name</Code> is worth getting right first time: renaming a
          technique later silently breaks every edge that pointed at it.
        </p>
      </section>

      <section className="flex flex-col gap-3">
        <H>Aliases</H>
        <p className="text-[13px] leading-relaxed text-text-secondary">
          One per line, and the highest-value field on the form after the description. Search
          matches these, so an alias is how somebody finds a technique when they only know what
          their coach calls it. Include the gym slang, the Portuguese, the misspelling people
          actually type.
        </p>
      </section>

      <section className="flex flex-col gap-3">
        <H>Category</H>
        <p className="text-[13px] leading-relaxed text-text-secondary">
          Pick from the list; it is exactly the nine the importer accepts. Anything else seeds
          and renders fine and then breaks the next spreadsheet re-import. The category also
          picks the three-letter code and colour on every Library row, which is what makes a
          long list scannable — so a wrong category is a wrong badge on every screen the
          technique appears.
        </p>
      </section>

      <section className="flex flex-col gap-3">
        <H>Position, position detail, gi/no-gi, typical belt</H>
        <p className="text-[13px] leading-relaxed text-text-secondary">
          These become the chips under the title and drive the Library&apos;s filters.{" "}
          <Code>Position</Code> is the coarse family the filters offer; <Code>Position
          detail</Code> is the specific configuration a coach would say — “Knee shield”, “Closed
          guard”. <Code>Typical belt</Code> is advisory, not a rule, and it is a filter, so
          leaving it blank makes the technique invisible to somebody filtering by belt.
        </p>
      </section>

      <section className="flex flex-col gap-3">
        <H>What an empty field does</H>
        <p className="text-[13px] leading-relaxed text-text-secondary">
          Nothing, on purpose. <strong className="text-text">A section with no content does not
          render at all</strong> — the app never shows an empty heading or a dash. So leaving a
          field blank is always safe and always honest; it is guessing that does damage. An
          empty <Code>To position</Code> means “not recorded”, never “goes nowhere”.
        </p>
      </section>

      <section className="flex flex-col gap-3">
        <H>After you save</H>
        <p className="text-[13px] leading-relaxed text-text-secondary">
          The technique is live in the catalog immediately — no deploy. But a release does not
          carry it until it has been exported: run{" "}
          <Code>go run ./cmd/exportcontent</Code>, review the diff, and merge it. Skip that and
          the row survives in the database and is missing from the next environment built from
          the seed files.
        </p>
        <p className="text-[13px] leading-relaxed text-text-secondary">
          <Link href="/content" className="underline">
            Back to techniques
          </Link>
        </p>
      </section>
    </>
  );
}

/* ------------------------------------------------------------------ bits -- */

function H({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="font-barlow-condensed text-[13px] font-bold tracking-[0.14em] text-text-muted uppercase">
      {children}
    </h2>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return <code className="font-mono text-[12px] text-text">{children}</code>;
}

function Callout({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-lg border border-border bg-card px-4 py-3 text-[13px] leading-relaxed text-text-secondary">
      {children}
    </p>
  );
}

/**
 * One authoring style and what the app actually does with it.
 *
 * `output` is the parser's real return value, not an illustration — `null`
 * means it produced no step list and the text falls back to a paragraph. The
 * verdict is carried by a word as well as a colour, because the whole console
 * is read at a glance and a red/green pair alone is not a signal everybody
 * receives.
 */
function Example({
  verdict,
  label,
  input,
  output,
  note,
}: {
  verdict: "good" | "bad";
  label: string;
  input: string;
  output: string[] | null;
  note?: string;
}) {
  const good = verdict === "good";
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-card px-4 py-3">
      <p className="flex items-center gap-2 text-[13px]">
        <span
          className={`font-barlow-condensed text-[11px] font-bold tracking-[0.12em] uppercase ${
            good ? "text-emerald-600" : "text-red-600"
          }`}
        >
          {good ? "Works" : "Breaks"}
        </span>
        <span className="text-text">{label}</span>
      </p>

      <pre className="overflow-x-auto rounded border border-border bg-page px-3 py-2 font-mono text-[12px] whitespace-pre-wrap text-text-secondary">
        {input}
      </pre>

      <div className="text-[12px] text-text-secondary">
        {output ? (
          <ol className="flex list-decimal flex-col gap-0.5 pl-5">
            {output.map((s, i) => (
              <li key={i} className={good ? "" : "text-red-700"}>
                {s}
              </li>
            ))}
          </ol>
        ) : (
          <p className="italic">Renders as a single paragraph — no steps.</p>
        )}
      </div>

      {note ? <p className="text-[12px] leading-relaxed text-text-secondary">{note}</p> : null}
    </div>
  );
}
