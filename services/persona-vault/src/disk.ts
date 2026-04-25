import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import yaml from "js-yaml";
import type { Identity } from "./types.js";

export async function listPersonas(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const ids: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    try {
      await stat(join(root, e.name, "identity.yaml"));
      ids.push(e.name);
    } catch {
      // missing identity.yaml — not a persona
    }
  }
  return ids;
}

export async function loadIdentity(
  root: string,
  personaId: string,
): Promise<Identity> {
  const path = join(root, personaId, "identity.yaml");
  const raw = await readFile(path, "utf8");
  const parsed = yaml.load(raw) as Identity;
  if (!parsed || typeof parsed !== "object" || !parsed.id) {
    throw new Error(`invalid identity.yaml at ${path}`);
  }
  return parsed;
}

export function credentialsPath(root: string, personaId: string): string {
  return join(root, personaId, "credentials.sops.yaml");
}
