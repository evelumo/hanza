# Security

## Report a vulnerability privately

Email **[hello@evelumo.com](mailto:hello@evelumo.com)**, the public contact address of the [repository's owning organization](https://github.com/evelumo), with the subject **Hanza security report**. Do not post exploit details, credentials or Buyer data in public issues or pull requests.

Include the affected commit, impact, reproduction steps using synthetic data, and any suggested mitigation. For suspected cross-tenant access, describe the two organizations and the affected operation without including real records.

GitHub private vulnerability reporting is not enabled at the time this guide was written. The email above is the reporting contact; no acknowledgement or remediation SLA is published.

## Version and deployment scope

Hanza is pre-release, with no published support matrix or maintenance branches. Include the exact commit when reporting a problem. Fixes are developed against `main`; do not assume an older checkout receives a backport.

The architecture includes organization scoping, sealed Connection credentials and Buyer data, and validated boundaries. These mechanisms are not a claim of an independent security audit or production certification.

Operators are responsible for securing network access, secret storage, backups and deployment processes. The [self-hosting guide](docs/self-hosting.md) describes the current runtime and encryption-key requirements. The checked-in Compose credentials are for local development.
