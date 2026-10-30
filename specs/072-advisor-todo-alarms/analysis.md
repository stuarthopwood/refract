# Analysis: spec 072

- Every FR maps to a task (T1 to T4) and a doc update (T5). #1098 has no FR: it is skipped until OMP reports a parked status.
- Overlap risk: `Readouts.tsx` and `settings.rs` (`KNOWN_FIELDS` count) are shared with other lanes; the `Readouts.tsx` diff is one import and one return.
- The Alarm popover uses only existing shared components, so no variant or component was added (ADR 0003).
- Alarms fire only while Refract runs; an Alarm more than 5 minutes overdue is dropped silently by design.
