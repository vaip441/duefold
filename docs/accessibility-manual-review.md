# Manual accessibility review pack

Status: **PENDING HUMAN REVIEW WITH ASSISTIVE TECHNOLOGY**  
Release commit: ________________________________  
Reviewer: ______________________________________  
Assistive technology/browser/OS: ______________  
Started (UTC): __________  Completed (UTC): __________

Use synthetic data. Run at least one desktop screen reader journey (NVDA with Firefox/Chrome or VoiceOver with Safari) and one mobile or narrow viewport viewer journey. Automation is supporting evidence, not a substitute for listening to the interface.

## Setup

- Confirm browser zoom at 100%, then repeat critical pages at 200%.
- Test light and dark themes; verify document pixels are not inverted.
- Use keyboard/screen-reader commands rather than the pointer except where comparison is required.
- Record defects without protected content, real identities, or secrets.

## Critical journeys

For each journey record PASS/FAIL, AT/browser, observations, and evidence.

| Journey | Checks | Result | Observations/evidence |
| --- | --- | --- | --- |
| Member sign-in | One clear heading; OIDC action and viewer alternative named; errors actionable; focus sensible |  |  |
| Viewer OTP | Neutral eligibility copy; email and eight-digit code instructions understandable; paste works; expiry/retry announced |  |  |
| Member workspace | Landmarks and collection/worktable relationships make sense; current room and status are announced |  |  |
| Upload/process/review | Validation, quarantine, failure, retry, and ready states are announced without color-only meaning |  |  |
| Publish room | Consequences precede confirmation; exact phrase is understandable; error and completion announced; focus returns |  |  |
| Access/grants | Grant source, inherited reach, expiry UTC/local meaning, exception, revoke impact, and dry-run counts are intelligible |  |  |
| Viewer room list | Only accessible rooms are discoverable; updated marker and personal access information are understandable |  |  |
| Protected preview | Page label and sanitized text reading order are useful; page change/find/link interstitial work; watermark does not block reading |  |  |
| Download | Allow/deny language is honest; original/no-watermark consequence is clear; denial is announced |  |  |
| Schedule purge | Delay, irreversible effect, typed phrase, errors, cancellation, and focus behavior are understandable |  |  |
| Status | Tables, timestamps, failing checks, backup/restore expectations, and next actions are comprehensible |  |  |

## Cross-cutting checks

- [ ] Meaningful DOM/reading sequence at desktop and 320 CSS px.
- [ ] Exactly one descriptive `h1` per view and useful region headings.
- [ ] No duplicate, missing, excessively verbose, or stale live announcements.
- [ ] Dialog names, descriptions, initial focus, Escape, and focus return are correct.
- [ ] Every control has a name matching its visible label and a visible focus indicator.
- [ ] Errors identify the field/problem and suggest a usable recovery.
- [ ] Status and selection are understandable without color.
- [ ] Reflow at 200% and 320 CSS px has no two-dimensional scrolling for ordinary content.
- [ ] Reduced motion removes spatial motion without hiding state feedback.
- [ ] Viewer content, peers, filenames, and inaccessible counts cannot be inferred from spoken output.

## Defects

| ID | WCAG criterion | Severity | Journey | Description | Resolution/retest | Status |
| --- | --- | --- | --- | --- | --- | --- |
|  |  |  |  |  |  |  |

## Reviewer decision

- [ ] PASS: critical journeys meet the manual WCAG 2.2 AA release gate.
- [ ] FAIL: defects prevent the accessibility claim and 1.0 release.

Decision rationale: ____________________________________________________________

Reviewer signature/name: ____________________  Date (UTC): ____________________

Maintainer acknowledgement: _________________  Date (UTC): ____________________
