export interface Identity {
  id: string;
  display_name: string;
  type: "principal" | "branded_bot" | "service_account";
  timezone: string;
  locale: string;
  working_hours: string;
  posting_cadence_minutes: [number, number];
  proxy_pool: string;
  disclosed_automation: boolean;
  platforms: Record<string, { enabled: boolean; credential_ref?: string }>;
}

export interface CredentialBundle {
  [platform: string]: Record<string, string>;
}

export interface CredentialRequest {
  requester_id: string;
  purpose: string;
}

export interface CredentialResponse {
  persona_id: string;
  platform: string;
  credential: Record<string, string>;
}

export interface AuditEntry {
  ts: string;
  persona_id: string;
  platform: string;
  requester_id: string;
  purpose: string;
}

export interface ListPersonasResponse {
  personas: string[];
}

export interface ListPlatformsResponse {
  persona_id: string;
  platforms: string[];
}
