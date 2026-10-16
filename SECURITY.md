# Security Policy

## Reporting a vulnerability

Please report security issues privately through GitHub's
[private vulnerability reporting](../../security/advisories/new) (the
**Security** tab → **Report a vulnerability**), not in a public issue.

Only the latest release is supported; fixes ship in a new release.

## Scope

This gateway bridges Signal and Apple iMessage traffic, communicating with a
local signal-cli RPC daemon and the remote macOS relay service. Of particular
interest are vulnerabilities that could allow unauthorized command or RPC
execution, bypass bearer token authentication, leak credentials or cryptographic
keys, or expose message content outside the configured endpoints.
