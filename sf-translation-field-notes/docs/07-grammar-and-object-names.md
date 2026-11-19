# Grammar, object names and renamed standard fields

Object names (Setup > Rename Tabs and Labels) and renamed standard field labels are stored as
`<caseValues>` inside `CustomObjectTranslation`, with grammar beside them: `<gender>`,
`<startsWith>`, and inside each case value `<article>` or `<possessive>`. Most rules below were
established by dry runs, one probe per value, so failures were attributable.

## The rule that matters most: grammar travels with the forms

**Grammar is only valid together with object-name `<caseValues>` for that object and language.**

- Sent with no `<caseValues>`, `<gender>` and `<startsWith>` were **silently discarded**: the
  deploy succeeded with 0 errors and stored nothing. Confirmed by a real deploy with before/after
  reads (hundreds of grammar values, none stored).
- In other payload shapes the same mistake failed loudly with a misleading message:
  `'Consonant' is not a valid value for the enum 'Gender'` (a bare `<startsWith>` parsed as gender).
- In retrieved metadata, no file had gender or startsWith without case values.

So you cannot seed grammar ahead of the names. Send the forms and their grammar in one payload.

**Translated content alone does not need grammar.** Field labels, layouts, record types and
validation rules deploy fine with no `<gender>`. Do not add gender just because a file has content.

## Gender values

- Exactly four values exist: `Feminine`, `Masculine`, `Neuter`, `AnimateMasculine` (no space).
  There is no `Common`. Danish and Swedish common gender maps to `Feminine`.
- **Gender is validated per language**, with two different error texts:
  - `'X' is not a valid value for the enum 'Gender'`: not a value at all.
  - `Invalid gender 'Masculine' for language DANISH`: a real value, not valid for that language.
- Values accepted per language. This is a general reference for common languages, not a complete
  list. Confirm any language with a one-value-per-component dry run before you rely on it:

| Languages | Accepted |
|---|---|
| `cs`, `pl`, `ru`, `sk` | Neuter, Feminine, Masculine, AnimateMasculine |
| `de`, `ro` | Masculine, Feminine, Neuter |
| `fr`, `fr_CA`, `it`, `es`, `es_MX`, `pt_PT`, `pt_BR`, `lv`, `lt` | Masculine, Feminine |
| `da`, `sv`, `nl_NL` | Feminine, Neuter (Masculine is rejected) |

- **Do not build an allow-list from what the org already contains.** Absence only means nobody has
  used that value yet. `AnimateMasculine` was valid for Russian although no Russian value in the
  org used it. Keep a deny-list of values proven rejected instead.
- A wrong gender often shows up late: a blank cell fails earlier with "Gender is required", which
  hides a bad dropdown value until someone picks it. Validate dropdown options against the table.
- **Standard objects are checked against Salesforce's own language pack.** For objects Salesforce
  has a localized name for (Account, Contact, Lead, Opportunity, ...), only the pack's gender is
  accepted, and the wrong one fails with the misleading "Gender is required". Objects without a
  localized name (for example AccountContactRelation, Activity, User) accepted any gender. The right
  genders are not exposed by any API; find them by dry run.
- **A field's gender is not the object's gender.** A renamed standard field's gender belongs to the
  field label's noun (German *die Größe*, feminine) and can differ from the object's
  (*der Artikel*, masculine). Never fall back from one to the other: one tool did, and fabricated
  wrong genders that looked authoritative. Expect few stored field genders; a blank usually means the
  org has none.

## startsWith, article, possessive

A general reference, grouped by the kind of grammar. For a language not listed, check by dry run.

| Group | Languages | Needs |
|---|---|---|
| startsWith only | `en_US`, `hu` | `<startsWith>` (Consonant / Vowel), no gender |
| startsWith as well as gender | `fr`, `fr_CA`, `it` | both |
| Article | `da`, `sv`, `ro` (and `no`) | `<article>` in each case value, plus gender |
| Possessive | `fi`, `hu` | `<possessive>` in each case value, no gender (hu also needs startsWith) |
| No gender | `et`, `fi` | none |

- Romanian needs **both** gender and article. An earlier note said it takes no gender; a dry run
  disproved that ("Gender is required for language ROMANIAN").
- `startsWith` accepted both `Consonant` and `Vowel` for every startsWith language tested.
- **On a renamed standard field, only the base article or possessive is legal.** A field label is a
  single slot: `<article>None</article>` (or `<possessive>None</possessive>`) was accepted;
  `Definite` / `Indefinite` failed with "You have specified invalid attributes for field ...". For
  `da`, `sv` and `ro` field case values, `<article>None</article>` is required when gender is set.
- **Object names: base forms only were accepted and persisted.** Earlier dry runs had produced
  "Article is required" / "Possessive is required" when only base forms were sent. Later, sets with
  only the base (`None`) form deployed for article and possessive languages, and a real deploy of
  object names built the same way was verified live in two orgs. What caused the earlier errors is
  unknown. Still send the `<article>` / `<possessive>` element itself.
- `<caseValues>` children allowed: `article`, `caseType`, `plural`, `possessive`, `value`, in that
  order. `<gender>` inside `<caseValues>` fails with "Element ... gender invalid at this location"; it
  belongs on the parent.
- An empty `<caseType></caseType>` is invalid. Omit it for languages without cases.
- Orgs may store case values in their own shape (for example `caseType` Nominative on a single-form
  field, `None` for article/possessive). Normalise before comparing, or every form reads as changed.

## Object Names: what users see is often not stored

- **Salesforce's built-in object names per language are not stored metadata.** A retrieve returns
  only names an admin has saved as overrides. In one org the stored overrides were well under a
  tenth of the names users saw.
- **No API returns the built-in case forms.** Metadata API, REST, Tooling, SOAP and XLIFF were all
  tried. `composite/batch` describe with `Accept-Language` gives the nominative singular and plural
  only. For some languages no API returned a localized label at all; check yours. The full set is
  visible in Setup > Rename Tabs and Labels, per language. A hand-maintained
  cache was the workaround; reading that Setup page programmatically was not attempted.
- **Pushing a displayed name writes an override equal to what users already see.** Nothing changes
  on screen, but the org now stores a custom name. Untested: whether a nominative-only override
  changes the other case forms Salesforce uses in case languages.
- **Grammar in a workbook with no matching name is not pushable.** Salesforce discards it.
- Check translator input for obvious slips before pushing: singular equal to plural, a verb instead
  of a noun, an English placeholder in a language column.

## Renamed standard fields

- Only renamed standard fields need translating; Salesforce translates unchanged standard labels.
- They live as `caseValues` on the field inside `CustomObjectTranslation` and are in **no**
  Bilingual export. Read them with a lone `CustomObjectTranslation` retrieve.
- In gendered languages, they need gender, or the row fails "Gender is required for language
  GERMAN" (or the language concerned).
- An `en_US` renamed label can be the target of a real fix (for example a truncated label).

## Language codes

- Dutch is `nl_NL`, not `nl`. `nl` fails "You cannot translate into nl". Delete stale `<Obj>-nl`
  folders before deploying.
- Take the language list from the union of
  `sf org list metadata --metadata-type Translations` and `--metadata-type CustomObjectTranslation`,
  and check the reader against an org you know has the languages before trusting a short list.
- A language slot can hold the wrong regional variant. One `pt_PT` slot held text byte-identical to
  the same org's `pt_BR`; markers such as Brazilian vs European spellings confirmed it. Compare a
  variant with its sibling before copying it to another org.
