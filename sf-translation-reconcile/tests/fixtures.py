"""Synthetic org reads for the tests: a tiny metadata-format retrieve and Bilingual exports.

Nothing here comes from a real org. Objects: Widget__c (custom), Activity (Task/Event
fields), Account (a renamed standard field); value set Colors; labels Greeting / Bye / Docs_Url.
"""
from __future__ import annotations

from pathlib import Path

HEAD = '<?xml version="1.0" encoding="UTF-8"?>\n'
X = 'xmlns="http://soap.sforce.com/2006/04/metadata"'

WIDGET_DE = HEAD + f"""<CustomObjectTranslation {X}>
    <fields>
        <label>Farbe</label>
        <name>Color__c</name>
        <picklistValues>
            <masterLabel>Blue</masterLabel>
            <translation><!-- Blue --></translation>
        </picklistValues>
        <picklistValues>
            <masterLabel>Red</masterLabel>
            <translation>Rot</translation>
        </picklistValues>
    </fields>
    <fields>
        <help>Zeile eins&#13;
Zeile zwei</help>
        <label><!-- Notes --></label>
        <name>Notes__c</name>
    </fields>
    <layouts>
        <layout>Widget Layout</layout>
        <sections>
            <label><!-- Details --></label>
            <section>Details</section>
        </sections>
    </layouts>
    <recordTypes>
        <label>Premium DE</label>
        <name>Premium</name>
    </recordTypes>
    <validationRules>
        <errorMessage>Farbe fehlt  </errorMessage>
        <name>Require_Color</name>
    </validationRules>
</CustomObjectTranslation>
"""

ACTIVITY_DE = HEAD + f"""<CustomObjectTranslation {X}>
    <fields>
        <label><!-- Topic --></label>
        <name>Topic__c</name>
    </fields>
</CustomObjectTranslation>
"""

ACCOUNT_FR = HEAD + f"""<CustomObjectTranslation {X}>
    <fields>
        <caseValues>
            <plural>false</plural>
            <value>Numero</value>
        </caseValues>
        <caseValues>
            <plural>true</plural>
            <value>Numeros</value>
        </caseValues>
        <gender>Masculine</gender>
        <name>AccountNumber</name>
        <startsWith>Consonant</startsWith>
    </fields>
</CustomObjectTranslation>
"""

COLORS_DE = HEAD + f"""<GlobalValueSetTranslation {X}>
    <valueTranslation>
        <masterLabel>Green</masterLabel>
        <translation><!-- Green --></translation>
    </valueTranslation>
</GlobalValueSetTranslation>
"""

DE_TRANSLATION = HEAD + f"""<Translations {X}>
    <customLabels>
        <label><!-- Goodbye --></label>
        <name>Bye</name>
    </customLabels>
    <customLabels>
        <label>Hallo</label>
        <name>Greeting</name>
    </customLabels>
</Translations>
"""

WIDGET_OBJECT = HEAD + f"""<CustomObject {X}>
    <fields>
        <fullName>Color__c</fullName>
        <label>Color</label>
        <type>Picklist</type>
        <valueSet>
            <valueSetDefinition>
                <value><fullName>Red</fullName><default>false</default><label>Red</label></value>
                <value><fullName>Blue</fullName><default>false</default><label>Blue</label></value>
                <value><fullName>Purple</fullName><default>false</default><isActive>false</isActive><label>Purple</label></value>
            </valueSetDefinition>
        </valueSet>
    </fields>
    <fields>
        <fullName>Notes__c</fullName>
        <inlineHelpText>Line one</inlineHelpText>
        <label>Notes</label>
        <type>Text</type>
    </fields>
    <fields>
        <fullName>Accent__c</fullName>
        <label>Accent</label>
        <type>Picklist</type>
        <valueSet><valueSetName>Colors</valueSetName></valueSet>
    </fields>
    <recordTypes>
        <fullName>Premium</fullName>
        <active>true</active>
        <label>Premium</label>
    </recordTypes>
    <validationRules>
        <fullName>Require_Color</fullName>
        <active>true</active>
        <errorMessage>Color is required</errorMessage>
    </validationRules>
</CustomObject>
"""

ACTIVITY_OBJECT = HEAD + f"""<CustomObject {X}>
    <fields>
        <fullName>Topic__c</fullName>
        <label>Topic</label>
        <type>Text</type>
    </fields>
</CustomObject>
"""

ACCOUNT_OBJECT = HEAD + f"""<CustomObject {X}>
    <fields><fullName>AccountNumber</fullName></fields>
</CustomObject>
"""

LAYOUT = HEAD + f"""<Layout {X}>
    <layoutSections>
        <customLabel>true</customLabel>
        <label>Details</label>
        <style>TwoColumnsTopToBottom</style>
    </layoutSections>
    <layoutSections>
        <customLabel>false</customLabel>
        <label>System Information</label>
        <style>TwoColumnsTopToBottom</style>
    </layoutSections>
</Layout>
"""

COLORS_GVS = HEAD + f"""<GlobalValueSet {X}>
    <customValue><fullName>Green</fullName><default>false</default><label>Green</label></customValue>
    <customValue><fullName>Old</fullName><default>false</default><isActive>false</isActive><label>Old</label></customValue>
    <masterLabel>Colors</masterLabel>
</GlobalValueSet>
"""

LABELS = HEAD + f"""<CustomLabels {X}>
    <labels><fullName>Bye</fullName><language>en_US</language><protected>false</protected><shortDescription>Bye</shortDescription><value>Goodbye</value></labels>
    <labels><fullName>Docs_Url</fullName><language>en_US</language><protected>false</protected><shortDescription>Docs</shortDescription><value>https://example.com/docs</value></labels>
    <labels><fullName>Greeting</fullName><language>en_US</language><protected>false</protected><shortDescription>Greeting</shortDescription><value>Hello</value></labels>
</CustomLabels>
"""

PACKAGE = HEAD + f"""<Package {X}>
    <types><members>*</members><name>CustomObjectTranslation</name></types>
    <version>62.0</version>
</Package>
"""

FILES = {
    "objectTranslations/Widget__c-de.objectTranslation": WIDGET_DE,
    "objectTranslations/Activity-de.objectTranslation": ACTIVITY_DE,
    "objectTranslations/Account-fr.objectTranslation": ACCOUNT_FR,
    "globalValueSetTranslations/Colors-de.globalValueSetTranslation": COLORS_DE,
    "translations/de.translation": DE_TRANSLATION,
    "objects/Widget__c.object": WIDGET_OBJECT,
    "objects/Activity.object": ACTIVITY_OBJECT,
    "objects/Account.object": ACCOUNT_OBJECT,
    "layouts/Widget__c-Widget Layout.layout": LAYOUT,
    "globalValueSets/Colors.globalValueSet": COLORS_GVS,
    "labels/CustomLabels.labels": LABELS,
    "package.xml": PACKAGE,
}

# What the org's Bilingual export says (consistent with the retrieve above, plus the
# inactive value 'Old', which a retrieve never shows).
STF_DE = [
    "# Language: German",
    "------------------TRANSLATED-------------------",
    "CustomField.Widget__c.Color.FieldLabel\tColor\tFarbe\t-",
    "PicklistValue.Widget__c.Color.Red\tRed\tRot\t-",
    "CustomField.Widget__c.Notes.HelpText\tLine one\tZeile eins\\nZeile zwei\t-",
    "RecordType.Widget__c.Premium\tPremium\tPremium DE\t-",
    "ValidationFormula.Widget__c.Require_Color\tColor is required\tFarbe fehlt  \t-",
    "PicklistValue.Colors__gvs.Old\tOld\tAlt\t-",
    "CustomLabel.Greeting\tHello\tHallo\t-",
    "------------------OUTDATED AND UNTRANSLATED-------------------",
    "PicklistValue.Widget__c.Color.Blue\tBlue",
    "CustomField.Widget__c.Notes.FieldLabel\tNotes",
    "LayoutSection.Widget__c.Widget Layout.Details_1\tDetails",
    "CustomField.Activity.Topic.FieldLabel\tTopic",
    "PicklistValue.Colors__gvs.Green\tGreen",
    "CustomLabel.Bye\tGoodbye",
]


def write_tree(root: Path, files: dict[str, str]) -> Path:
    for rel, text in files.items():
        p = root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        with open(p, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(text)
    return root


def write_retrieve(base: Path, files=None) -> Path:
    """A retrieve the way `--target-metadata-dir X --unzip` leaves it: X/unpackaged/..."""
    write_tree(base / "unpackaged", files or FILES)
    return base


def write_stf(d: Path, lines, lang="de", stamp="2026-01-01 1000") -> Path:
    d.mkdir(parents=True, exist_ok=True)
    with open(d / f"Bilingual_{lang}_{stamp}.stf", "w", encoding="utf-8", newline="\n") as fh:
        fh.write("\n".join(lines) + "\n")
    return d


def workbook(path: Path, sheets: dict[str, list[list]]) -> Path:
    import openpyxl
    wb = openpyxl.Workbook()
    wb.remove(wb.active)
    for name, rows in sheets.items():
        ws = wb.create_sheet(name)
        for r in rows:
            ws.append(r)
    path.parent.mkdir(parents=True, exist_ok=True)
    wb.save(path)
    return path
