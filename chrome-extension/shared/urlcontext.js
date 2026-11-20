// Turns the address of a Salesforce page into "what the person is looking at", so the flow search
// can start with the object or field filled in. Pure: no browser APIs, no network. Only the path of
// the address is used; nothing from it is kept except an object name, a field name or an Id.

const OBJECT_ID = /^01I[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/; // custom object Id
const FIELD_ID = /^00N[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/; // custom field Id
const RECORD_ID = /^[A-Za-z0-9]{3}[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/;
const API_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;

export const isObjectId = (s) => OBJECT_ID.test(String(s || ""));
export const isFieldId = (s) => FIELD_ID.test(String(s || ""));

function decode(s) {
  try { return decodeURIComponent(s); } catch { return null; }
}

/** An object or field name from the address: an API name, or (for custom objects and fields) an Id. */
function nameOrId(seg, idTest) {
  const s = decode(seg || "");
  if (!s) return null;
  if (idTest && idTest(s)) return s;
  return API_NAME.test(s) ? s : null;
}

/** What the address says the person is looking at.
 *  Returns {object, field} where each is an API name, an Id (01I for an object, 00N for a field) or "" when unknown,
 *  or null when the address is not one we understand (junk, another kind of page, not a URL).
 *  Understood:
 *    /lightning/setup/ObjectManager/<object>/FieldsAndRelationships/<field>/...   object and field
 *    /lightning/setup/ObjectManager/<object>/...                                  object only
 *    /lightning/r/<Object>/<record Id>/...                                        object only
 *    /lightning/o/<Object>/...                                                    object only  (list views, home)
 */
export function parseUrlContext(url) {
  let path;
  try { path = new URL(String(url)).pathname; } catch { return null; }
  const seg = path.split("/").filter(Boolean);
  if (seg[0] !== "lightning") return null;

  if (seg[1] === "setup" && seg[2] === "ObjectManager") {
    const object = nameOrId(seg[3], isObjectId);
    if (!object || object.toLowerCase() === "home") return null; // "ObjectManager/home" is the list of objects
    if (seg[4] === "FieldsAndRelationships") {
      const field = nameOrId(seg[5], isFieldId);
      // "view", "new" and "fieldSelection" are not field names
      if (field && !/^(view|new|fieldSelection)$/i.test(field)) return { object, field };
    }
    return { object, field: "" };
  }
  if (seg[1] === "r") {
    const object = nameOrId(seg[2]);
    if (object && RECORD_ID.test(seg[3] || "")) return { object, field: "" };
    return null;
  }
  if (seg[1] === "o") {
    const object = nameOrId(seg[2]);
    return object ? { object, field: "" } : null;
  }
  return null;
}

/** The query-string part ("object=Account&field=Status__c") for the page address, or "" when there is nothing to pass. */
export function contextQuery(ctx) {
  if (!ctx || !ctx.object) return "";
  const q = new URLSearchParams({ object: ctx.object });
  if (ctx.field) q.set("field", ctx.field);
  return q.toString();
}

/** Read the `object` and `field` parameters of the flow page address back. An API name is kept, and so is a custom
 *  object Id (01I) or custom field Id (00N), which is how Setup addresses them; anything else becomes "". */
export function contextFromParams(params) {
  const clean = (v, idTest) => {
    const s = String(v || "").trim();
    return API_NAME.test(s) || idTest(s) ? s : "";
  };
  return { object: clean(params.get("object"), isObjectId), field: clean(params.get("field"), isFieldId) };
}

/** Pick the real API name of a custom object or field from its parts, using the names the org says exist.
 *  `names` are API names; `namespace` and `developerName` come from Setup (no suffix). A custom thing ends in
 *  "__c" most of the time, but also "__mdt", "__e", "__x", "__b", "__pc" and so on, so the exact "__c" name is
 *  preferred and any other suffix is accepted when only one name fits. Returns "" when none fits. */
export function pickByDeveloperName(names, namespace, developerName) {
  const base = `${namespace ? namespace + "__" : ""}${developerName}`.toLowerCase();
  const list = [...names];
  const exact = list.find((n) => n.toLowerCase() === `${base}__c`);
  if (exact) return exact;
  const others = list.filter((n) => n.toLowerCase().startsWith(`${base}__`) && !n.slice(base.length + 2).includes("__"));
  return others.length === 1 ? others[0] : "";
}
