import { mkdtempSync, mkdirSync } from "node:fs";
import { join, relative } from "node:path";
import { preparedFixture } from "./prepared-fixture.ts";
import { registerPreparedGround } from "../../src/assets/catalog/local.ts";
mkdirSync(".local", { recursive: true });
const root = mkdtempSync(".local/ground-admission-e2e-"),
  { zip, asset } = await preparedFixture();
const index = await registerPreparedGround({
  root: join(root, "library"),
  packageBytes: zip,
  review: {
    contentVersion: asset.definition.metadata.contentVersion,
    licenseChecked: true,
    decision: "trial",
    limitations: ["Constructed software fixture; zero qualified new assets"],
    recordReference: "docs/validation/riverside-integration.md",
  },
  candidateScope: "prepared-ground-only",
});
console.log(relative(process.cwd(), index));
