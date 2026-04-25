import { describe, it, expect } from "vitest";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { listPersonas, loadIdentity } from "../src/disk.js";
import { makeTmpPersonaRoot, writePersona, SAMPLE_IDENTITY } from "./helpers.js";

describe("disk layer", () => {
  it("lists persona IDs from a root directory", async () => {
    const root = await makeTmpPersonaRoot();
    await writePersona(root, "persona_a", SAMPLE_IDENTITY);
    await writePersona(root, "persona_b", SAMPLE_IDENTITY);

    const ids = await listPersonas(root);
    expect(ids.sort()).toEqual(["persona_a", "persona_b"]);
  });

  it("ignores directories without identity.yaml", async () => {
    const root = await makeTmpPersonaRoot();
    await writePersona(root, "persona_a", SAMPLE_IDENTITY);
    await mkdir(join(root, "not_a_persona"), { recursive: true });

    const ids = await listPersonas(root);
    expect(ids).toEqual(["persona_a"]);
  });

  it("loads and parses identity.yaml", async () => {
    const root = await makeTmpPersonaRoot();
    await writePersona(root, "persona_a", SAMPLE_IDENTITY);

    const id = await loadIdentity(root, "persona_a");
    expect(id.id).toBe("persona_test");
    expect(id.display_name).toBe("Test Persona");
    expect(id.platforms.discord.enabled).toBe(true);
    expect(id.platforms.reddit.enabled).toBe(false);
  });

  it("throws when identity.yaml is missing", async () => {
    const root = await makeTmpPersonaRoot();
    await expect(loadIdentity(root, "no_such_persona")).rejects.toThrow();
  });
});
