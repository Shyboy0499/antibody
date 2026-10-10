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

## The same probe for Gemini CLI

`gemini-mock.mjs` is that idea for Gemini CLI: a stand-in for the Gemini API that answers
the task router's JSON request, has the CLI run one command per turn from `STEP0_COMMANDS`,
and ends the turn. The CLI reaches it through the base URL it already honours, so again no
model is involved and the payloads are the client's own hook stdin. Commands are PowerShell
on Windows, which is the shell Gemini CLI's shell tool uses there.

1. Install the CLI, and run the mock with the commands to probe:

   ```sh
   npm i @google/gemini-cli
   STEP0_COMMANDS='["node -e \"console.log(2); process.exit(3)\""]' \
     STEP0_REQUESTS=/tmp/gemini-requests.log node gemini-mock.mjs &
   ```

2. Put a capture hook in the project's `.gemini/settings.json` - the hook shape
   `antibody setup gemini` writes, with the command `node /path/to/capture.mjs`, where
   that script appends its stdin to `$STEP0_CAPTURE` - and run the CLI:

   ```sh
   GEMINI_CLI_NO_RELAUNCH=1 GEMINI_API_KEY=dummy \
     GOOGLE_GEMINI_BASE_URL=http://127.0.0.1:15798 gemini -p "run the probe" --yolo
   ```

3. Read the captured payloads. The ones this produced (0.63.0, 2026-10-10) are in
   [`tests/gemini.test.ts`](../../tests/gemini.test.ts).
