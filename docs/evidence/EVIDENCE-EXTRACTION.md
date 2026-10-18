# Evidence extraction

`evidence extract --session UUID` copies tutor-authored annotations into the archive evidence graph
and creates source-linked candidates from transcript phrases. Candidate types cover possible
instructions, concepts, explanations, corrections, learner misconceptions, worked examples, learning
outcomes, follow-up priorities, and questions.

Transcript matching is deterministic and lexical. It does not identify a speaker, establish that a
claim is correct, or prove that a learner made progress. Every transcript-derived record remains
`needs-review`, stores its transcript segment ID, timestamp, optional speaker label, detection method,
and a heuristic confidence value. Candidates and copied annotations record their exact source
revision. Tutors must approve or reject candidates before they appear in a generated guide; approval
fails when a source is missing, cross-session, or has changed since extraction. The phrase catalog
currently targets English transcripts; other languages remain available as verbatim transcript
evidence and tutor-authored annotations.

Re-running extraction is idempotent per source revision and candidate type. A corrected transcript
creates a new candidate and leaves the prior review in archive history.

Guides keep verified transcript candidates grouped by their reviewed event type. A verified question
or explanation is not relabeled as a tutor instruction. Each generated block cites both its evidence
node and the source transcript segment so reviewers can inspect the original wording and timing.
