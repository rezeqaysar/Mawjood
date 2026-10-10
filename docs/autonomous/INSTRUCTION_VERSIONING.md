# Autonomous Instruction Versioning

**Status:** Mandatory governance for any autonomous agent working on Mawjood.

**Purpose:** Ensure major agent instructions are reproducible and auditable.

## Rule

Critical autonomous instructions are not allowed to exist only in chat
sessions.

A batch instruction that materially affects implementation must be stored
as a durable versioned artifact or referenced in the batch contract (see
`BATCH_CONTRACT_TEMPLATE.md`).

## Store

For each major instruction record:

- instruction ID;
- version;
- date;
- owner authorization reference;
- applicable repository/batch;
- autonomy level;
- allowed scope;
- forbidden actions;
- expected outputs;
- related batch contract.

## Changes

Changing a critical instruction creates a new version. Do not silently
overwrite historical meaning. History is never rewritten: supersede by
amendment, preserving the prior version byte-identical.

## Purpose

This allows future agents to understand:

- what the agent was told;
- why it acted;
- which constraints applied;
- how to reproduce or audit behavior.

## Provider neutrality

Instructions describe desired behavior and governance. They must not
depend on a specific provider's hidden memory or undocumented behavior.
Instructions are written for roles (coordinator, implementation agent,
review agent), not for vendors.
