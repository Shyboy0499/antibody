# Step 0: capture live Claude Code hook payloads

`mock.mjs` is a minimal Anthropic-compatible endpoint. It replays a fixed list of
Bash commands, so Claude Code runs them and fires its hooks with real stdin. No
model is involved; the payloads are the client's own.

1. Replace `<folder-for-payloads>` in `settings.json` with a folder on your machine.
2. Run the mock with the commands to probe:

   ```sh
   export STEP0_COMMANDS='["node -e \"console.log(2); process.exit(3)\" 2>&1 | tail -5"]'
   node mock.mjs &
   ```

3. Run Claude Code against it:

   ```sh
   ANTHROPIC_BASE_URL=http://127.0.0.1:15799 ANTHROPIC_API_KEY=sk-test \
     claude -p "run the probe" --settings /path/to/settings.json \
     --allowedTools Bash --output-format text < /dev/null
   ```

4. Read `payloads.jsonl` in the folder you chose.
