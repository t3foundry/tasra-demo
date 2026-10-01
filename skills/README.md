# Agent skills for tasra-sdk

Each folder is one [agent skill](https://agentskills.io): a `SKILL.md` that a coding
agent loads when the task matches its description. One format serves every agent; the
installers differ only in where they copy the folder.

## Install into your project

Installing the SDK does **not** install skills into your agent. The package includes
them under `node_modules/tasra-sdk/skills/`. Copy the whole skill folders — not just
the `SKILL.md` — into the directory your agent discovers:

```sh
mkdir -p .agents/skills
cp -R node_modules/tasra-sdk/skills/tasra-* .agents/skills/
```

The directory name varies by agent; check yours for where it looks for project
skills. Review existing folders before copying so you keep local customisations, and
start a new session if the installed skills do not appear. Ask the agent to use
`tasra-getting-started`, then the skill for your task.

**After each SDK upgrade, refresh the copied skills from that exact installed
package.** npm updates the package, not these copies. Keep local modifications in
separate skills, or review their diff before replacing one. Record
`node -p "require('tasra-sdk/package.json').version"` alongside the copied set.

Installing these instructions needs no private checkout, global installer or platform
credentials. Skills do not configure a network or grant access to anything.

## The set

| Skill | Use it when |
|---|---|
| [tasra-getting-started](tasra-getting-started/SKILL.md) | npm installation, deployment configuration and choosing a complete app |
| [tasra-create-slot](tasra-create-slot/SKILL.md) | durable creation, provisioning and uncertain-transaction recovery |
| [tasra-credentials-and-sessions](tasra-credentials-and-sessions/SKILL.md) | operation authorizers, holder binding and credential lifetime; existing JWT sessions when needed |
| [tasra-dcql-rules](tasra-dcql-rules/SKILL.md) | writing, validating and evaluating a slot's access rule |
| [tasra-handle-errors](tasra-handle-errors/SKILL.md) | refusals, cancellation, readiness polling and uncertain-outcome reconciliation |
| [tasra-sign-and-decrypt](tasra-sign-and-decrypt/SKILL.md) | public EVM address, viem signing, shared accounts and two independent document signatures |
| [tasra-ibe-identity-scoped](tasra-ibe-identity-scoped/SKILL.md) | typed BLS encryption/decryption, strict extraction and explicit share trust |
| [tasra-chain](tasra-chain/SKILL.md) | address books, the read client, on-chain discovery, events |
| [tasra-committee-path](tasra-committee-path/SKILL.md) | native FROST approval quorum, resume and advanced committee operations |
| [tasra-oid4vp-wallet-and-verifier-agent](tasra-oid4vp-wallet-and-verifier-agent/SKILL.md) | OpenID4VP wallets, the Verifier Agent, credential issuance |
| [tasra-hovi-issuer](tasra-hovi-issuer/SKILL.md) | an explicitly selected Hovi integration; local development does not require it |

Skills cite documentation included in the package, so an agent can read the full
text under `node_modules/tasra-sdk/` and the exact types
from `node_modules/tasra-sdk/dist/**/*.d.ts`.

## First verified application

Start with `tasra-getting-started`, then load only the skill for the requested task.
Install with `npm install tasra-sdk@latest`. The application interface is
`tasra-sdk/app`. See the [application guide](../docs/application-api.md),
[shared account](../docs/shared-account.md), [encrypted notes](../docs/encrypted-notes.md),
[document signatures](../docs/document-signing.md), and [native approvals](../docs/native-approvals.md).

Each skill leads with the modern workflow. Longer `references/advanced.md` files
preserve existing specialized and compatibility APIs; read them when the task needs
those capabilities. They are not fallback authorization routes after a refusal.
Copy the whole folder so these references remain available.

`docs/`, `examples/` and `dist/` paths in skill text refer to the installed SDK root,
not the directory where the skill was copied. The skills contain no private setup
knowledge. Complete sources are shipped in the package. The selected network
must support the application’s requested key modes and authorization routes.

Deployment records live in [tasra-releases](https://github.com/t3-foundry/tasra-releases),
not the npm package. Fuji's `networks/testnet/current.json` points to
`deployments/tasra-fuji-v1.json` and supplies its checksum. Use `tasra-chain` to
bootstrap from one reviewed repository revision, then discover the slot's keepers.
A verified manifest and successful registry read establish configuration and
connectivity. Test protected operations separately before claiming compatibility.
