import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve, dirname } from "node:path";
import {
  prepareTrial,
  readTrial,
  submitTrial,
  pollTrial,
  downloadTrial,
} from "./worldlabs/trial.mjs";
import {
  REQUEST_SHA,
  PRICE_CHECKED_ON,
  identifier,
} from "./worldlabs/request.mjs";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultDir = resolve(project, ".local/worldlabs-river-trial-v1");
const HELP = `World Labs single riverbank trial (Node >=24)
  npm run worldlabs -- prepare       Freeze draft request offline; no key read
  npm run worldlabs -- status        Show local progress and key presence only
  npm run worldlabs -- submit --approve-paid-once --confirm-request SHA256 --price-reviewed-on YYYY-MM-DD
  npm run worldlabs -- poll          One operation GET; never resubmits
  npm run worldlabs -- poll --operation-id ID --confirm-request SHA256
  npm run worldlabs -- download      Only100k SPZ; no API key sent

submit is a PAID action: do not run until the prompt and current price are reviewed.
Expected $1.264; budget $1.30 is NOT a provider-enforced cap. Read docs/WORLDLABS_TRIAL.md.
Credentials: session-only WLT_API_KEY, never an argument or .env created by this tool.
Fixed local trial directory: ${defaultDir}
No retries, reset command, automatic polling, uploads or GitHub publishing.
`;
function parse(argv) {
  const [command = "help", ...rest] = argv;
  const allowed = {
    help: [],
    prepare: [],
    status: [],
    submit: ["--approve-paid-once", "--confirm-request", "--price-reviewed-on"],
    poll: ["--operation-id", "--confirm-request"],
    download: [],
  };
  if (!Object.hasOwn(allowed, command))
    throw Error("unknown-command: use help");
  const flags = {};
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if (!allowed[command].includes(flag) || Object.hasOwn(flags, flag))
      throw Error("invalid-or-duplicate-option");
    if (flag === "--approve-paid-once") flags[flag] = true;
    else {
      if (!rest[i + 1] || rest[i + 1].startsWith("--"))
        throw Error("option-value-required");
      flags[flag] = rest[++i];
    }
  }
  if (
    command === "submit" &&
    (flags["--approve-paid-once"] !== true ||
      flags["--confirm-request"] !== REQUEST_SHA ||
      flags["--price-reviewed-on"] !== PRICE_CHECKED_ON ||
      flags["--price-reviewed-on"] !== new Date().toISOString().slice(0, 10))
  )
    throw Error("explicit-current-approval-required");
  if (
    command === "poll" &&
    (flags["--operation-id"] !== undefined ||
      flags["--confirm-request"] !== undefined)
  ) {
    if (flags["--confirm-request"] !== REQUEST_SHA)
      throw Error("recovery-confirmation-required");
    identifier(flags["--operation-id"]);
  }
  return { command, flags };
}
export async function runCli(
  argv,
  { dir = defaultDir, env = process.env } = {},
) {
  const { command, flags } = parse(argv);
  if (command === "help") return HELP;
  if (Number(process.versions.node.split(".")[0]) < 24)
    throw Error("node24-or-newer-required");
  let state;
  if (command === "prepare") state = await prepareTrial(dir);
  else if (command === "status") state = await readTrial(dir);
  else if (command === "submit")
    state = await submitTrial(dir, {
      approvePaidOnce: true,
      requestSha: flags["--confirm-request"],
      priceDate: flags["--price-reviewed-on"],
      key: env.WLT_API_KEY,
    });
  else if (command === "poll")
    state = await pollTrial(dir, {
      key: env.WLT_API_KEY,
      operationId: flags["--operation-id"],
      requestSha: flags["--confirm-request"],
    });
  else state = await downloadTrial(dir);
  return JSON.stringify(
    {
      ...state,
      credentialPresent: Object.hasOwn(env, "WLT_API_KEY"),
      directory: dir,
      notice:
        "Local technical state only. No visual acceptance. Budget is not a provider-enforced cap.",
    },
    null,
    2,
  );
}
if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  try {
    console.log(await runCli(process.argv.slice(2)));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
