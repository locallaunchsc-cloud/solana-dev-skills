# Contributing to Solana Dev Skills

Skills here follow the [Anthropic Skills](https://www.anthropic.com/news/agent-skills) / [Bankr Skills](https://github.com/BankrBot/skills) format. The goal is that each skill is **install-ready** — an agent (or a human) can run it end-to-end without leaving the folder.

## Add a new skill

1. Fork this repo and create a branch.
2. Create a folder for your skill:
   ```
   mkdir your-skill-name/
   ```
3. Add `SKILL.md` (the only required file) with YAML frontmatter:
   ```markdown
   ---
   name: solana-your-skill-name
   description: Use this skill when the user wants to [trigger]. Covers [scope].
   ---
   ```
4. Optionally add:
   - `scripts/` — runnable example code (TypeScript, Rust, Bash)
   - `references/` — deeper supporting docs or cheatsheets
5. Open a PR.

## Quality bar

A skill is mergeable when:

- [ ] YAML frontmatter has `name` (prefixed `solana-`) and `description` with concrete trigger phrases
- [ ] All package / crate versions are **pinned** to current as of the merge date
- [ ] Every command in the workflow is copy-pasteable and tested
- [ ] At least 5 common pitfalls listed with concrete error codes or messages
- [ ] No marketing fluff. Dev tone, expert level.
- [ ] External references link to official docs, not random blogs
- [ ] If the skill consumes a third-party SDK, the SDK is verifiably maintained (last release < 6 months old). Otherwise link to docs / REST API and skip the script.

## SKILL.md structure

```markdown
---
name: solana-skill-name
description: ...
---

# Skill Title

## Overview
2-4 sentences. What and why.

## When to use this skill
Bullet list of specific triggers.

## Prerequisites
Install commands. Pin versions.

## Workflow
Step-by-step with copy-pasteable code. Include expected output where useful.

## Common pitfalls
5+ real gotchas with specific error codes or symptoms.

## References
- Official docs
- GitHub repos
- Useful tools
```

## Updating an existing skill

When SDK versions, API endpoints, or program IDs change, please:

1. Bump pinned versions everywhere they appear (SKILL.md prereqs, scripts, references)
2. Verify each command still works on devnet or mainnet as appropriate
3. Note the date of the verification in the PR description

## Style

- Write for an experienced developer, not a beginner. Skip "what is Solana" preamble.
- Prefer terse imperative over passive voice ("Run `solana airdrop 2`" beats "You will want to run an airdrop").
- Include the actual expected output of commands (not a placeholder).
- Cite real exploits where applicable in security-related skills.
- Don't include screenshots — they go stale faster than text.

## License

By contributing, you agree your contribution is licensed under the project's [MIT License](LICENSE).
