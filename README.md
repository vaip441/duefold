<div align="center">

<h1>
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="apps/web-client/public/brand/logo-dark.svg">
  <img alt="Duefold" src="apps/web-client/public/brand/logo-light.svg" width="200">
</picture>
</h1>

**The investor data room you run yourself.**

Built by a founder, for founders. 100% free and open source.

[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-2f6f62)](LICENSE)
[![Self-hosted](https://img.shields.io/badge/self--hosted-Docker%20Compose-555)](docs/self-hosting.md)

</div>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/reading-room-dark.png">
  <img alt="An investor reading a quarterly update in the Duefold reading room, with the room's folders on the left and access notes on the right." src="docs/images/reading-room.png">
</picture>

Share your cap table, financial model, and contracts with investors without a link anyone can forward or a data room priced for investment banks. Duefold runs on your own infrastructure and does what a fundraise needs, nothing more.

## Features

- **Invite people, not links.** Investors sign in with a one-time code sent to their email. A forwarded invitation lets nobody else in.
- **Publish when you're ready.** Investors see nothing until you publish it.
- **Simple permissions.** Give a person or a whole firm access to a room, a folder, or a single document, until a date you choose.
- **Safe previews.** Every upload is virus-scanned and converted in an isolated sandbox. Investors read documents in the browser.
- **Watermarks.** Every page shows the reader's email, the date, and the room.
- **Download control.** Allow or block downloads per document.
- **Audit log.** See who opened what, and export it.
- **Your data stays yours.** Your own PostgreSQL database and S3-compatible storage.

Works on phones, in dark mode, and with a keyboard or screen reader.

<table>
  <tr>
    <td width="50%" valign="top">
      <img alt="The Processing tab lists uploads with their state: one isolated as malware, one conversion failed with a retry button, one still being checked." src="docs/images/member-processing.png">
      <p>Every upload is scanned before it can be published.</p>
    </td>
    <td width="50%" valign="top">
      <img alt="The Access tab shows one reader with access to the whole room until a set date, with controls to change the end date or remove access." src="docs/images/member-access.png">
      <p>See who can read what, and until when.</p>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <img alt="The invited-reader sign-in page asks for the email address the invitation was sent to." src="docs/images/viewer-sign-in.png">
      <p>Investors sign in with an email code. No passwords.</p>
    </td>
    <td width="50%" valign="top">
      <img alt="The reading room on a phone, showing the document tree and the first page of the investor update." src="docs/images/reading-room-phone.png">
      <p>The same reading room on a phone.</p>
    </td>
  </tr>
</table>

## Get started

On your own server with Docker Compose:

```sh
git clone https://github.com/vaip441/duefold.git && cd duefold
cp .env.example .env    # your domain, sign-in, mail, and storage settings
docker compose up -d
```

The [self-hosting guide](docs/self-hosting.md) walks through each setting.

Before choosing another host, read the [host requirements](docs/host-requirements.md): the document sandbox needs kernel features that many managed platforms don't grant. The [Railway + Cloudflare R2 + Resend](docs/railway-deployment.md) guide is for evaluation with synthetic data only, because Railway can't provide that sandbox.

## Good to know

- Watermarks discourage leaks. They can't stop a phone camera.
- A file that has been downloaded can't be recalled.
- The audit log is append-only, but someone with direct database access could still change it.

Duefold deliberately leaves out NDAs, Q&A, engagement analytics, and DRM.

## Security

Read the [threat model](docs/security/threat-model.md), [data flow and trust boundaries](docs/security/data-flow.md), [ASVS map](docs/security/asvs-map.md), and [incident-response runbook](docs/security/incident-response.md). Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Copyright (C) 2026 Georg Kalme. Licensed under the [GNU AGPL v3.0](LICENSE): free to use and modify for your company. If you offer a modified version to others over a network, you must share your changes.
