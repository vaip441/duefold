# Security policy

Security fixes go to the latest release.

## Reporting a vulnerability

Report it privately: open the repository's **Security** tab and choose **Report a vulnerability**. Please don't open a public issue.

Include the version or commit, steps to reproduce, and the impact, using synthetic data only. This is a small project without a formal response time, but every report is answered, fixes are coordinated with you, and you get credit if you want it.

## In scope

- Reaching content without a grant, or seeing unpublished content
- Getting an original file when downloads are off
- Learning that rooms, documents, or other investors exist without having access to them
- Weaknesses in authentication, sessions, or CSRF protection
- Escaping the worker sandbox
- A database role gaining access it shouldn't have
- Changing audit events through the application
- Secrets, email addresses, or document content leaking into logs or support bundles

## Not vulnerabilities

- Screenshots or photos of watermarked pages
- Files that were downloaded before downloads were turned off
- Audit changes made with direct database administrator access
- Encryption at rest, which is handled by the storage provider
