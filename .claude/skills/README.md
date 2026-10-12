# Claude Code skills for this repo

Claude Code loads every `<name>/SKILL.md` here on demand (locally and in cloud sessions). Root `AGENTS.md` wins on any conflict.

| Skill | What it covers | Source |
|---|---|---|
| `numa-shared` | Project skill (this repo) | Owner, adapted for this repo |
| `write-swift` | How to write modern Swift well — modeling with value types, Swift 6 data-race safety and approachable concurrency (@concurrent, main-actor-by-default,... | emilkowalski/skills @ 85e8e2363b713506e1d5b6e07a0eb2da66be1bc3 (MIT). 'Initial Response' boilerplate removed. |
| `convex-expert` | Convex backend specialist. Use this agent for any code inside a `convex/` directory — function definitions, schemas, indexes, queries, mutations, acti... | get-convex/agent-skills @ 2cfe645c87f971242cfc8ef3eb53662cbec26a53 (Apache-2.0). |
| `convex-reviewer` | Convex code reviewer — security, auth, validators, performance, and pattern checks for code in a convex/ directory. Use to review or audit Convex func... | get-convex/agent-skills @ 2cfe645c87f971242cfc8ef3eb53662cbec26a53 (Apache-2.0). |
| `convex-deploy-guard` | Classify + announce the target Convex deployment before any deployment-affecting command; fresh explicit consent for prod actions; session read-only m... | get-convex/agent-skills @ 2cfe645c87f971242cfc8ef3eb53662cbec26a53 (Apache-2.0). |

Third-party skills are pinned copies; update deliberately from the named source, not blindly.
