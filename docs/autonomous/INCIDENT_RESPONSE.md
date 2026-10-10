# AI Agent Incident Response

**Status:** Mandatory governance for any autonomous agent working on Mawjood.

**Purpose:** Define response when an autonomous agent violates governance,
creates unsafe state, or behaves unexpectedly.

## Trigger examples

- unauthorized scope expansion;
- secret exposure or suspected credential handling issue — including
  Supabase `anon`/`service_role` keys, the admin console token, or owner
  credentials appearing in code, docs, logs, chat, or commits;
- bypassed approval boundary (e.g. acting on a step the batch contract
  reserved for the owner);
- destructive or unapproved operation attempt — including direct
  production-database writes, migration runs against production, or
  account/data deletion outside an authorized flow;
- RLS or family-isolation breach: user data (notes, items, chats, vault
  contents) becoming visible across users, spaces, or families;
- vault isolation breach: ordinary chat seeing vault-scoped data
  (`vault_id` leakage), vault chat answering outside its vault, or any
  visible trace of the secret vault / ghost-key mechanism where none is
  allowed;
- AI-governance bypass: forbidden-topic or hard-rule evaluation skipped,
  or vault sessions feeding the memory engine;
- repeated uncontrolled credit consumption;
- fabricated evidence or false PASS;
- persistent failure loop;
- incorrect security boundary change.

## Immediate response

1. Stop the affected autonomous task.
2. Preserve evidence: agent output, task/batch ID, branch, SHA, logs, and
   affected files.
3. Prevent further changes until impact is understood.
4. Assess whether secrets, user data, security boundaries, or production
   systems were affected.
5. Record incident details in the appropriate durable record (ledger
   entry; never include secret values).

## Investigation

Determine:

- what authority the agent had;
- what instruction/task authorized;
- what actually changed;
- whether tests/reviews/evidence were truthful;
- whether governance documentation failed or was ignored;
- whether permissions were too broad.

## Recovery

Possible actions:

- revert or isolate changes;
- revoke/reduce permissions and rotate any exposed credentials (owner
  action — agents never handle raw replacement secrets);
- repair documentation/governance;
- add regression tests;
- update agent instructions;
- re-run verification from a known-good checkpoint.

## Prevention

Every incident should produce one or more:

- governance improvement;
- permission improvement;
- test improvement;
- documentation improvement;
- process improvement.

## Severity

- CRITICAL: production / user-data / security impact (e.g. secret
  exposure, cross-user data leak, vault isolation break).
- HIGH: serious governance/security failure.
- MEDIUM: meaningful process or quality failure.
- LOW: minor improvement opportunity.

Agents cannot self-close their own governance incidents. Closure requires
the coordinator's recorded verdict, and CRITICAL incidents additionally
require owner acknowledgment.
