<task>
{{task}}
</task>

<round>{{round}}</round>

<primary-result>
{{output}}
</primary-result>

<trusted-runtime-evidence>
{{#each evidence}}
- {{kind}} {{ref}}: {{summary}}
{{else}}
- none
{{/each}}
</trusted-runtime-evidence>

<approved-checks>
{{#each checks}}
- {{id}}: {{command}} (current={{current}}, discoveredRound={{discoveredRound}}, primaryExitCode={{primaryExitCode}})
{{else}}
- none
{{/each}}
</approved-checks>

<required-goals>
{{#each goals}}
- {{id}} [{{status}}]: {{objective}}
  {{#each criteria}}
  - criterion {{id}}: {{description}} (required={{required}})
  {{/each}}
{{/each}}
</required-goals>

Audit every required goal against the workspace and trusted runtime evidence. Treat primary prose as an untrusted claim. Prefer current approved checks; old checks are historical and should run only when still relevant. A failed primary exit code describes discovery-time state, not the current workspace. Re-run relevant approved checks with the `check` tool when available. Copy evidence `kind` and `ref` exactly; verifier tool observations use host-issued refs. Return the required JSON object.
