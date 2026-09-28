# Security Policy

## Supported Versions

| Version | Supported |
| ------- | --------- |
| 0.1.x   | Yes       |
| < 0.1   | No        |

## Reporting a Vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Instead, please report them privately via
[GitHub private vulnerability reporting](https://github.com/garamahq/bedrock-forge/security/advisories/new).

Include the following in your report:

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

## Response Timeline

- **Acknowledgement:** within 48 hours
- **Initial assessment:** within 5 business days
- **Fix or mitigation:** depends on severity, but critical issues are
  prioritized

## Security Practices

Bedrock Forge follows these security practices:

- **Credentials at rest:** AES-256-GCM encryption for SSH keys, database
  passwords, and API tokens
- **Authentication:** JWT with refresh token rotation, bcrypt password hashing
  (12 rounds)
- **Authorization:** Role-based access control (admin / manager / maintainer /
  client)
- **Input validation:** Global validation pipe with whitelist + forbid unknown
  fields
- **Rate limiting:** Global and per-endpoint throttling
- **Security headers:** Helmet with HSTS enabled
- **Remote commands:** Server operations execute through SSH and helper
  scripts; command arguments are validated or escaped before execution. Local
  subprocesses use argument arrays where supported.
- **Dependency auditing:** `pnpm audit` in CI pipeline

## Disclosure Policy

We follow coordinated disclosure. Once a fix is released, we will credit the
reporter (unless they prefer to remain anonymous) and publish a security
advisory.
