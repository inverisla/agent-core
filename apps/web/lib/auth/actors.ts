// Who is acting, for the audit log (task 13).
import type { AuditActor } from "@agent-core/db";
import type { TenantAccess } from "./guards.ts";
import type { OperatorIdentity } from "./identity.ts";

export const tenantActor = (access: TenantAccess): AuditActor => ({
  kind: "user",
  userId: access.userId,
  label: access.email,
});

export const operatorActor = (operator: OperatorIdentity): AuditActor => ({
  kind: "operator",
  oid: operator.oid,
  label: operator.email ?? operator.name ?? "operator",
});
