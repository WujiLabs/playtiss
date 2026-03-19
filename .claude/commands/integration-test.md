Run the Playtiss integration test that exercises the full system (graphql-server, pipeline-runner, typescript-worker, cli).

## Instructions

1. Run the integration test script from the project root:

```bash
cd $ARGUMENTS && bash scripts/integration-test.sh --verbose
```

If no argument is provided, default to the current project root.

2. **If the script exits 0**: Report success — all integration test steps passed.

3. **If the script exits non-zero**: Read the output carefully to diagnose which step failed. Common failure modes:
   - **Port 4000 already in use**: Another graphql-server instance is running. Kill it first with `lsof -ti:4000 | xargs kill`.
   - **Timeout waiting for COMPLETED**: A service crashed. Check the log files mentioned in the output.
   - **Missing test DB**: The `graphql-server/playtiss-test-add3.db` file is missing.
   - **Node version issue**: Ensure `nvm use 24.13` works.

4. Report the results to the user with the pass/fail count and any failures.
