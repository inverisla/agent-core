# Contributing

agent-core is a starter kit: firms take a copy and build their own agents on it. Thank you
for wanting to improve it.

- **Bugs and ideas:** open an issue. Say what you expected, what happened, and how to
  reproduce it.
- **Security problems:** never in an issue. Report them privately, as
  [SECURITY.md](SECURITY.md) explains.
- **Code:** please open an issue first and agree the change there. Pull requests are
  accepted only for changes agreed in an issue, because changes to tenant separation,
  sign-in, storage or the model gateway need careful review. A pull request must pass CI
  and keep to the technical rules in [CLAUDE.md](CLAUDE.md) (its "Hard constraints" and
  the sections on database access, files, jobs, access and audit), which is written for
  people and coding agents alike. Its "How to work" section is the maintainers' own
  process; you don't need to follow it.
  `docs/development.md` explains how to run everything locally.
- **Forks:** you're welcome to fork it for your own clients; that is what it is for.

Comments that cite a review finding, such as "(review S5)" or "Review 2.4", refer to a
pre-publication review kept private; `docs/DECISIONS.md` says more, and each cited place
explains itself.

Contributions are made under the Apache License 2.0 (section 5 of [LICENSE](LICENSE));
there is no separate contributor agreement.

Everyone taking part is expected to follow the [code of conduct](CODE_OF_CONDUCT.md).
