import { readFile } from "node:fs/promises";
import { join } from "node:path";
import yaml from "js-yaml";

interface Identity {
  id: string;
  posting_cadence_minutes: [number, number];
}

/**
 * Reads identity.yaml from a personas root directory and caches each
 * persona's identity in memory for the life of the process. Operator can
 * `docker compose restart core` to pick up edits — documented in
 * ops/local/runbook.md. See Plan 4 D6.
 */
export class IdentityLoader {
  #cache = new Map<string, Identity>();

  constructor(private readonly personasRoot: string) {}

  async cadenceMinutes(personaId: string): Promise<[number, number]> {
    const id = await this.#load(personaId);
    return id.posting_cadence_minutes;
  }

  async #load(personaId: string): Promise<Identity> {
    const cached = this.#cache.get(personaId);
    if (cached) return cached;
    const path = join(this.personasRoot, personaId, "identity.yaml");
    const raw = await readFile(path, "utf8");
    const parsed = yaml.load(raw) as Identity;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !Array.isArray(parsed.posting_cadence_minutes) ||
      parsed.posting_cadence_minutes.length !== 2
    ) {
      throw new Error(
        `identity.yaml for ${personaId} is missing valid posting_cadence_minutes`,
      );
    }
    this.#cache.set(personaId, parsed);
    return parsed;
  }
}
