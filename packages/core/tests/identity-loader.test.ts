import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IdentityLoader } from "../src/ratelimit/identity-loader.js";

const IDENTITY = `id: p_alpha
display_name: "p_alpha"
type: branded_bot
timezone: UTC
locale: en-US
working_hours: "00:00-23:59"
posting_cadence_minutes: [12, 45]
proxy_pool: none
disclosed_automation: true
platforms:
  discord:
    enabled: true
`;

async function setup(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "id-loader-"));
  await mkdir(join(root, "p_alpha"), { recursive: true });
  await writeFile(join(root, "p_alpha", "identity.yaml"), IDENTITY, "utf8");
  return root;
}

describe("IdentityLoader", () => {
  it("loads posting_cadence_minutes for a persona", async () => {
    const root = await setup();
    const loader = new IdentityLoader(root);
    const cadence = await loader.cadenceMinutes("p_alpha");
    expect(cadence).toEqual([12, 45]);
  });

  it("caches identities — second load does not re-read disk", async () => {
    const root = await setup();
    const loader = new IdentityLoader(root);
    await loader.cadenceMinutes("p_alpha");
    await writeFile(
      join(root, "p_alpha", "identity.yaml"),
      IDENTITY.replace("[12, 45]", "[99, 999]"),
      "utf8",
    );
    const cadence = await loader.cadenceMinutes("p_alpha");
    expect(cadence).toEqual([12, 45]);
  });

  it("throws on unknown persona", async () => {
    const root = await setup();
    const loader = new IdentityLoader(root);
    await expect(loader.cadenceMinutes("ghost")).rejects.toThrow();
  });
});
