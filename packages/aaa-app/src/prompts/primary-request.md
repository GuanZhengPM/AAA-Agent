<task>
{{task}}
</task>

<round>{{round}}/{{maxRounds}}</round>

{{#if recoveryGuidance}}
<recovery>
{{recoveryGuidance}}
</recovery>
{{/if}}

{{#if contextState}}
Prior durable context (host-maintained; newer task instructions win):
{{#each contextState.userGoals}}
- User goal [{{status}}]: {{objective}}
{{/each}}
{{#each contextState.completedGoals}}
- Completed goal: {{this}}
{{/each}}
{{#each contextState.remainingGoals}}
- Remaining goal: {{this}}
{{/each}}
{{#each contextState.verifiedFacts}}
- Verified fact: {{statement}}
{{/each}}
{{#each contextState.artifacts}}
- Verified artifact: {{kind}} {{ref}}{{#if summary}} — {{summary}}{{/if}}
{{/each}}
{{#each contextState.openRisks}}
- Open risk: {{this}}
{{/each}}
{{#if contextState.recoveryGuidance}}
- Recovery guidance: {{contextState.recoveryGuidance}}
{{/if}}
{{/if}}

{{#if facts.length}}
<verified-facts>
{{#each facts}}
- {{statement}}
{{/each}}
</verified-facts>
{{/if}}

{{#if artifacts.length}}
<verified-artifacts>
{{#each artifacts}}
- {{kind}}: {{ref}}{{#if summary}} — {{summary}}{{/if}}
{{/each}}
</verified-artifacts>
{{/if}}

{{#if goals.length}}
<current-goals>
{{#each goals}}
- {{id}}: {{objective}}
{{/each}}
</current-goals>
{{/if}}

{{#if subagents.length}}
<subagent-findings>
{{#each subagents}}
### {{taskId}} ({{status}})
{{#each findings}}
{{summary}}
{{/each}}
{{#if unresolved.length}}
Unresolved: {{#each unresolved}}{{this}}; {{/each}}
{{/if}}
{{/each}}
</subagent-findings>
{{/if}}

Complete the current goal frontier in the workspace. Do not repeat work already established by verified facts.
