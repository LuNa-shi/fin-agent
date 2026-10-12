## What changed

<!-- Describe the user-visible problem and the resulting behavior. -->

## Why

<!-- Explain the product or engineering reason for this change. -->

## Authority and boundaries

- [ ] I identified the domain authority and write boundary affected by this change.
- [ ] Public projections do not expose credentials, raw provider payloads, private objects, or local paths.
- [ ] The change does not introduce silent provider fallback, fake outputs, arbitrary filesystem access, or hidden context truncation.
- [ ] Generated documents were updated through their source generator when applicable.

## Validation

Commands run:

```text
# Add commands and results here.
```

- [ ] Focused tests pass.
- [ ] `git diff --check` passes.
- [ ] `git status --short` was reviewed.
- [ ] I ran the full clean-install gate, or explained why it was not run below.

## Risk and follow-up

<!-- Describe migration, compatibility, data, provider, or operational risks. Mention checks that were not run. -->
