// Copyright (c) 2026 Sean R Fulton. All rights reserved. No permission is granted to use, copy, modify,
// or distribute this software without written permission.

// The one list of tools. The toolbar menu (menu.js) and the Settings page (settings.js) both read it.
// To add a tool: add an entry here and ship its page. `id` is the tool's folder name under tools/;
// it is what the Settings page remembers, so never rename one.
export const TOOLS = [
  {
    id: "compare-groups",
    page: "tools/compare-groups/compare-groups.html",
    title: "Compare permission set groups",
    description: "Find out how two permission set groups differ",
  },
  {
    id: "user-access",
    page: "tools/user-access/user-access.html",
    title: "User access summary and comparison",
    description: "See what a user can access, compare two users, or see who is in each Einstein Activity Capture configuration",
  },
  {
    id: "hierarchy",
    page: "tools/hierarchy/hierarchy.html",
    title: "Territory & role hierarchy",
    description: "See the whole territory or role tree; export it for Excel",
  },
  {
    id: "record-access",
    page: "tools/record-access/record-access.html",
    title: "Why can a user see this record?",
    description: "Explain who can see the record open in this tab, and why",
    // Needs the record open in this tab: its Id goes in the address of the page.
    needsRecord: true,
    noRecordDescription: "Open a record first, then explain who can see it and why",
  },
  {
    id: "flow-usage",
    page: "tools/flow-usage/flow-usage.html",
    title: "Where is it used in flows?",
    description: "Find the flows that use an object, a field or a record Id",
    context: true, // the page can start from the object or field of the Salesforce page that is open
  },
  {
    id: "page-details",
    page: "tools/page-details/page-details.html",
    title: "Page details for a ticket",
    description: "Copy who you are, which org and which page, to paste into a ticket",
    withPageAddress: true,
  },
  {
    id: "error-tracer",
    page: "tools/error-tracer/error-tracer.html",
    title: "Error Tracer: read a debug log",
    description: "See what failed, where and for which user, from a debug log",
  },
  {
    id: "who-grants",
    page: "tools/who-grants/who-grants.html",
    title: "Where does a user get this permission?",
    description: "Find every profile, permission set and group that gives a user one permission",
  },
  {
    id: "audit-trail",
    page: "tools/audit-trail/audit-trail.html",
    title: "Search the Setup Audit Trail",
    description: "Find who changed what in Setup, without downloading a file",
  },
];
