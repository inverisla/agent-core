# Security

agent-core keeps one client's tenants apart from each other, so a hole in that separation,
or anything that lets someone reach data, sign in as someone else, or run code, matters
more than most bugs.

## Reporting a vulnerability

**Please do not open a public issue.** Report it privately through GitHub: the
repository's **Security** tab, **Report a vulnerability**. Include what you found, how to
reproduce it, and what an attacker could do with it.

You'll get an acknowledgement within five working days. We'll keep you informed while we
fix it, and credit you in the advisory and the fixing commit unless you'd rather not be
named.

## Scope

In scope: this repository's code, its database migrations and row-level security, its
GitHub Actions workflows and its Bicep. Out of scope: your own deployment's settings and
the services it runs on (Azure, Temporal Cloud, model providers): report those to their
owners.

## Supported versions

Only the latest `main` is maintained. A copy you have taken is yours to keep up to date:
watch this repository's security advisories, and merge their fixes.
