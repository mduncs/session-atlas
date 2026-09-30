# Local librarian coordinator

`src/library/librarians/index.ts` exports profile validation, permission
fingerprints, the tool-free OpenAI-compatible transport, and
`LibrarianCoordinator(store, profile, transport)`. The coordinator exposes
`run({limit?})`, `inspect()`, `pause()`, `resume()`, `retry(jobId?)`, and
`authorizeEgress(fingerprint)`. Profiles require exact endpoint/model, explicit
harness/role scope, standard redaction, concurrency and run/daily token caps.
Dollar caps require configured input/output rates and their verification date.
Remote egress is blocked until the matching endpoint/model/content-policy
fingerprint has been saved. Credentials are environment-variable references.
No provider, paid model or source scope is inferred.

Jobs persist in the isolated library, including input/prompt/policy identity,
source revision, dependencies, coverage, attempts, lease ownership/deadline,
outputs, reservation and actual usage. Up to configured concurrency sessions
run simultaneously; each uses bounded sequential map/reduce requests. The
reservation transaction checks run and daily caps before dispatch. Usage-less
successes, submission timeouts and ambiguous failures retain their reservation.
Deliberate retry adds a new reservation; it does not refund the old unknown
charge. Known rejected requests release estimates. Reported cached usage is
tracked separately; it is conservatively priced at the input rate. Expired
in-flight leases become unknown, not an automatic new paid submission. Pause
stops new dispatch; in-flight work may finish. Retryable failures get at most
three attempts; invalid schema gets one retry. Refusals do not trigger evasion.

The HTTP adapter disables redirects, supplies no tools, bounds response bytes
and timeout, and validates the compatible response envelope. Compatibility is
not implied for every service offering a similar endpoint. Provider metadata,
credentials and source paths are not placed in prompts. Map and reduction
source citations are local aliases; their source-backed refs remain local.
Existing redaction is applied before splitting: protected source lines and
private-key blocks are conservatively masked with preserved UTF-8 byte
coordinates, preventing secrets split between jobs from leaking. This can mask
nonsecret text on the same line; the omission manifest discloses it. Reduction
text also crosses the centralized redaction boundary.

The census pages through the complete dialogue reader, with Unicode-safe
source spans and a conservative UTF-8-byte token bound including framing.
Tool/control records and attachments are outside that dialogue projection;
content coverage does not mean the model understood it. Oversized maps split
without losing source bytes, including overflow replanning up to depth four.
Reducers lower fan-in and replan chronological claim groups, capped at depth
four for replanning. Every child is explicitly accounted for, evidence retained,
and reversal kinds preserved. Full local map claim chronology survives prose
compression. An unsplittable overflow stays incomplete with its child ledger;
it cannot overwrite the last good interpretation. Source revisions are checked
at job completion and final publication. Model-origin suggestions remain
inspectable job output and never silently demote an uncertain conversation.

Normalized topic labels accumulate in a full local candidate index. Matching
labels from two distinct conversations create overlapping provisional
collections. Existing durable rename/hide/pin/membership overlays remain
applied when derived membership is regenerated. This is deterministic label
matching, not certified semantic collection quality or a synonym-merging model.

## Tests and the real quality gate

`bun test test/library-librarians.test.ts` exercises UTF-8 coverage/redaction,
late reversals, origin non-demotion, collection overlays, policy permission,
unknown billing/restart, pause, expired lease, supersession, schema/refusal
faults, atomic daily reservation contention and mocked HTTP transport. Tests
make no network calls. Fake outputs are labeled `mock`; real `validated`
provenance means structural validation, not an independent truthfulness score.

Prepare an offline trial with:

```
bun src/library/librarians/eval.ts --prepare /absolute/new-evaluation-directory
```

This writes 60 source-backed synthetic captures, seed labels and a blank
review template: 20 long/multitopic, 15 technical human starts, 30 held-out.
Import captures only into a disposable library, run an explicitly authorized
provider profile there, and have an independent reviewer examine the exact
outputs against source evidence. The generated seed labels are not independent
human judgments. Complete reviewer/evidence notes and numeric rubric counts,
then run:

```
bun src/library/librarians/eval.ts --score /absolute/completed-review.jsonl
```

The scorer rejects missing cases, duplicate IDs and unfilled reviews. It reports
development/held-out topic recall, membership precision and zero-tolerance
failures. No memberships evaluated is not a passing precision result. The
60-case real-provider quality/cost gate has **not run**; no automatic quality,
entailment, topic-recall or membership-precision claim is made.
