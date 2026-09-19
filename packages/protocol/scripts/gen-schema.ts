import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { AnyMessage, PairOffer } from "../src/messages.js";
import { CapabilityCard, PrivacySettings } from "../src/common.js";
const dir = join(import.meta.dir, "..", "schema");
mkdirSync(dir, { recursive: true });
for (const [name, s] of Object.entries({ AnyMessage, PairOffer, CapabilityCard, PrivacySettings })) {
  writeFileSync(join(dir, `${name}.schema.json`), JSON.stringify(z.toJSONSchema(s, { target: "draft-2020-12", unrepresentable: "any" }), null, 2));
}
console.log("schemas written");
