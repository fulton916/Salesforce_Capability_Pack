// Copyright (c) 2026 Sean R Fulton. All rights reserved. No permission is granted to use, copy, modify,
// or distribute this software without written permission.

// Reads shared by several tools. Read-only: one SOQL query.

/** The org's name, edition and sandbox flag, as shown in each page's header. */
export async function readOrg(api, apiHost) {
  const { records } = await api.query("SELECT Id, Name, IsSandbox, InstanceName, OrganizationType FROM Organization");
  const o = records[0] || {};
  return { id: o.Id, name: o.Name, isSandbox: o.IsSandbox === true, instance: o.InstanceName, edition: o.OrganizationType, host: apiHost };
}
