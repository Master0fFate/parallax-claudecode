---
name: hyperplan
description: Harden a non-trivial plan through a three-round adversarial critique and evidence-based synthesis.
argument-hint: "[plan]"
user-invocable: true
---

# Hyperplan

Use `parallax_hyperplan` on `$ARGUMENTS` when integration, security, migration, architecture, or operational risk justifies the cost. Let trivial plans skip unless the user requests `force`.

1. Generate the analysis round. Dispatch returned prompts independently so critics do not anchor on one another.
2. Collect structured findings from the selected Pragmatist, Integration Tester, Sentinel, Architectural Strategist, and Humanist angles.
3. Generate cross-attacks using all round-one findings. Require DEFEND, REFINE, or CONCEDE outcomes backed by evidence.
4. Generate defenses from the attack map. A defense must cite a constraint or observation; rhetoric is not evidence.
5. Synthesize all critiques. Apply surviving hard constraints, decisions, risks, and open questions to the plan.

Do not paste hostile-agent prose into the final plan. Deduplicate findings, reject unsupported claims, preserve provenance for material risks, and state what changed.
